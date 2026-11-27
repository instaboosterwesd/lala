// Package codexauth signs the app in to a ChatGPT subscription through the
// device-code OAuth flow the Codex CLI uses: the browser shows a one-time code,
// the user approves it, and the server holds the resulting tokens (access,
// refresh, ChatGPT account id) for every LLM request.
//
// The tokens belong to the signed-in ChatGPT account, so the store keeps them in
// the settings table under one key and refreshes the access token before it
// expires. Nothing here is OpenAI's public API: it is the client contract of the
// Codex CLI (client id, issuer and backend base URL are the CLI's public
// constants), which is why the constants live in this one file.
package codexauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/Autumn-27/artex/db"
)

// Public constants of the Codex CLI's OAuth client. Client ids are identifiers,
// not secrets.
const (
	Issuer          = "https://auth.openai.com"
	ClientID        = "app_EMoamEEZ73f0CkXaXp7hrann"
	VerificationURL = Issuer + "/codex/device"
	// BaseURL is the Responses endpoint family that accepts a ChatGPT access
	// token; profiles point their base_url here (the provider appends /responses).
	BaseURL = "https://chatgpt.com/backend-api/codex"
	// DefaultModel is the first-choice Codex model; the actual account model
	// catalogue is fetched from the authenticated backend before selection.
	DefaultModel = "gpt-6.2-sol"

	settingKey = "chatgpt.oauth"
	// refreshSkew keeps a request from racing an expiry: refresh this long before.
	refreshSkew = 3 * time.Minute
)

// Tokens is one connected ChatGPT account, as persisted in the settings table.
type Tokens struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	AccountID    string    `json:"account_id,omitempty"`
	Email        string    `json:"email,omitempty"`
	Plan         string    `json:"plan,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

// DeviceCode is the pending half of a device login: what the UI shows, plus the
// handle needed to poll for approval.
type DeviceCode struct {
	DeviceAuthID    string    `json:"device_auth_id"`
	UserCode        string    `json:"user_code"`
	VerificationURL string    `json:"verification_url"`
	Interval        int       `json:"interval"`
	ExpiresAt       time.Time `json:"expires_at"`
}

// Model is a model the signed-in account can select from the Codex backend.
type Model struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
}

// ErrNotConnected means no ChatGPT account is signed in.
var ErrNotConnected = errors.New("chatgpt: not connected")

// ErrReauthRequired means the refresh token was rejected: the user must run the
// device login again.
var ErrReauthRequired = errors.New("chatgpt: sign-in expired, connect again")

// Store owns the connected account. It is safe for concurrent use: every LLM
// request asks it for a token, and refreshes are serialized.
type Store struct {
	db     *db.DB
	client *http.Client

	mu     sync.Mutex
	tokens *Tokens
}

// NewStore loads any previously saved account. A missing or unreadable row is
// not fatal: the app simply starts disconnected.
func NewStore(database *db.DB) *Store {
	s := &Store{
		db:     database,
		client: &http.Client{Timeout: 30 * time.Second},
	}
	if database == nil {
		return s
	}
	if raw, ok, err := database.GetSetting(settingKey); err == nil && ok {
		var t Tokens
		if json.Unmarshal([]byte(raw), &t) == nil {
			s.tokens = &t
		}
	}
	return s
}

// Status returns a copy of the connected account, if any.
func (s *Store) Status() (Tokens, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokens == nil || s.tokens.AccessToken == "" {
		return Tokens{}, false
	}
	return *s.tokens, true
}

// Clear forgets the account (disconnect).
func (s *Store) Clear() error {
	s.mu.Lock()
	s.tokens = nil
	s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	return s.db.SetSetting(settingKey, "")
}

func (s *Store) save(t *Tokens) error {
	s.mu.Lock()
	s.tokens = t
	s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	raw, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return s.db.SetSetting(settingKey, string(raw))
}

// AccessToken returns a usable access token plus the ChatGPT account id,
// refreshing first when the current one is about to expire.
func (s *Store) AccessToken(ctx context.Context) (string, string, error) {
	s.mu.Lock()
	t := s.tokens
	s.mu.Unlock()
	if t == nil || t.AccessToken == "" {
		return "", "", ErrNotConnected
	}
	if time.Until(t.ExpiresAt) > refreshSkew && t.AccountID != "" {
		return t.AccessToken, t.AccountID, nil
	}
	// Serialize refreshes: a burst of concurrent requests must not spend the
	// single-use refresh token several times.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tokens != nil && time.Until(s.tokens.ExpiresAt) > refreshSkew && s.tokens.AccountID != "" {
		return s.tokens.AccessToken, s.tokens.AccountID, nil
	}
	if s.tokens == nil || s.tokens.RefreshToken == "" {
		return "", "", ErrReauthRequired
	}
	refreshed, err := s.refreshLocked(ctx, s.tokens.RefreshToken)
	if err != nil {
		return "", "", err
	}
	if err := s.saveLocked(refreshed); err != nil {
		return "", "", err
	}
	return refreshed.AccessToken, refreshed.AccountID, nil
}

// Models fetches the model catalogue available to this ChatGPT account.
func (s *Store) Models(ctx context.Context) ([]Model, error) {
	token, accountID, err := s.AccessToken(ctx)
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(BaseURL + "/models")
	q := u.Query()
	q.Set("client_version", "0.0.1")
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("chatgpt-account-id", accountID)
	req.Header.Set("originator", "codex_cli_rs")
	req.Header.Set("OpenAI-Beta", "responses=experimental")
	req.Header.Set("User-Agent", "codex_cli_rs/0.0.1")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chatgpt: model catalogue failed: HTTP %d: %s", resp.StatusCode, clip(raw))
	}
	var catalog struct {
		Models []struct {
			Slug          string `json:"slug"`
			DisplayName   string `json:"display_name"`
			Visibility    string `json:"visibility"`
			SupportedInAPI bool  `json:"supported_in_api"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil {
		return nil, fmt.Errorf("chatgpt: decode model catalogue: %w", err)
	}
	models := make([]Model, 0, len(catalog.Models))
	for _, model := range catalog.Models {
		if model.Slug == "" || model.Visibility != "list" || !model.SupportedInAPI {
			continue
		}
		name := model.DisplayName
		if name == "" {
			name = model.Slug
		}
		models = append(models, Model{ID: model.Slug, Name: name})
	}
	if len(models) == 0 {
		return nil, errors.New("chatgpt: account returned no selectable models")
	}
	return models, nil
}

// refreshLocked posts the refresh grant. Codex sends JSON here (not the
// form-encoded body a generic OAuth client would); the response carries no
// expires_in, so the new access token's own exp claim is authoritative.
func (s *Store) refreshLocked(ctx context.Context, refreshToken string) (*Tokens, error) {
	body, _ := json.Marshal(map[string]string{
		"client_id":     ClientID,
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/oauth/token", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusBadRequest {
		return nil, ErrReauthRequired
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chatgpt: refresh failed: HTTP %d: %s", resp.StatusCode, clip(raw))
	}
	var tr tokenResponse
	if err := json.Unmarshal(raw, &tr); err != nil {
		return nil, fmt.Errorf("chatgpt: refresh response: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, ErrReauthRequired
	}
	t := tokensFrom(tr)
	// A refresh may omit the refresh token; keep the old one then.
	if t.RefreshToken == "" {
		t.RefreshToken = refreshToken
	}
	return t, nil
}

func (s *Store) saveLocked(t *Tokens) error {
	s.tokens = t
	if s.db == nil {
		return nil
	}
	raw, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return s.db.SetSetting(settingKey, string(raw))
}

// StartDevice asks OpenAI for a one-time code the user approves in a browser.
func (s *Store) StartDevice(ctx context.Context) (*DeviceCode, error) {
	body, _ := json.Marshal(map[string]string{"client_id": ClientID})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/api/accounts/deviceauth/usercode", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chatgpt: could not start sign-in: HTTP %d: %s", resp.StatusCode, clip(raw))
	}
	var out struct {
		DeviceAuthID string      `json:"device_auth_id"`
		UserCode     string      `json:"user_code"`
		Interval     flexedInt   `json:"interval"`
		ExpiresAt    flexedTime  `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("chatgpt: sign-in response: %w", err)
	}
	interval := int(out.Interval)
	if interval <= 0 {
		interval = 5
	}
	exp := time.Time(out.ExpiresAt)
	if exp.IsZero() {
		exp = time.Now().Add(15 * time.Minute)
	}
	return &DeviceCode{
		DeviceAuthID:    out.DeviceAuthID,
		UserCode:        out.UserCode,
		VerificationURL: VerificationURL,
		Interval:        interval,
		ExpiresAt:       exp,
	}, nil
}

// PollDevice checks whether the code was approved. pending=true means "not yet";
// on approval the code is exchanged for tokens and the account is stored.
func (s *Store) PollDevice(ctx context.Context, deviceAuthID, userCode string) (pending bool, t *Tokens, err error) {
	body, _ := json.Marshal(map[string]string{"device_auth_id": deviceAuthID, "user_code": userCode})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/api/accounts/deviceauth/token", bytes.NewReader(body))
	if err != nil {
		return false, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return false, nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	// 403/404 = approval still pending (Codex treats both as "keep polling").
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound {
		return true, nil, nil
	}
	if resp.StatusCode != http.StatusOK {
		return false, nil, fmt.Errorf("chatgpt: sign-in failed: HTTP %d: %s", resp.StatusCode, clip(raw))
	}
	var code struct {
		AuthorizationCode string `json:"authorization_code"`
		CodeVerifier      string `json:"code_verifier"`
	}
	if err := json.Unmarshal(raw, &code); err != nil {
		return false, nil, fmt.Errorf("chatgpt: sign-in response: %w", err)
	}
	if code.AuthorizationCode == "" || code.CodeVerifier == "" {
		return true, nil, nil
	}
	tokens, err := s.exchange(ctx, code.AuthorizationCode, code.CodeVerifier)
	if err != nil {
		return false, nil, err
	}
	if err := s.save(tokens); err != nil {
		return false, nil, err
	}
	return false, tokens, nil
}

// exchange redeems the authorization code. The redirect URI is the device
// login's own callback, exactly as Codex records it.
func (s *Store) exchange(ctx context.Context, code, verifier string) (*Tokens, error) {
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("redirect_uri", Issuer+"/deviceauth/callback")
	form.Set("client_id", ClientID)
	form.Set("code_verifier", verifier)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Issuer+"/oauth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chatgpt: token exchange failed: HTTP %d: %s", resp.StatusCode, clip(raw))
	}
	var tr tokenResponse
	if err := json.Unmarshal(raw, &tr); err != nil {
		return nil, fmt.Errorf("chatgpt: token response: %w", err)
	}
	if tr.AccessToken == "" {
		return nil, errors.New("chatgpt: token response carried no access token")
	}
	return tokensFrom(tr), nil
}

type tokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	IDToken      string `json:"id_token"`
}

// tokensFrom derives the account id, email, plan and expiry from the token set:
// the ids live in the id_token's claims, the deadline in the access token's exp.
func tokensFrom(tr tokenResponse) *Tokens {
	t := &Tokens{
		AccessToken:  tr.AccessToken,
		RefreshToken: tr.RefreshToken,
		ExpiresAt:    jwtExpiry(tr.AccessToken),
	}
	if t.ExpiresAt.IsZero() {
		t.ExpiresAt = time.Now().Add(50 * time.Minute)
	}
	claims := jwtClaims(tr.IDToken)
	if claims == nil {
		claims = jwtClaims(tr.AccessToken)
	}
	if claims != nil {
		if auth, ok := claims["https://api.openai.com/auth"].(map[string]any); ok {
			t.AccountID, _ = auth["chatgpt_account_id"].(string)
			t.Plan, _ = auth["chatgpt_plan_type"].(string)
		}
		if prof, ok := claims["https://api.openai.com/profile"].(map[string]any); ok {
			t.Email, _ = prof["email"].(string)
		}
		if t.Email == "" {
			t.Email, _ = claims["email"].(string)
		}
	}
	return t
}

// jwtClaims decodes a JWT payload without verifying it: the token came straight
// from the issuer over TLS and is only read for display fields.
func jwtClaims(token string) map[string]any {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}

func jwtExpiry(token string) time.Time {
	claims := jwtClaims(token)
	if claims == nil {
		return time.Time{}
	}
	if exp, ok := claims["exp"].(float64); ok && exp > 0 {
		return time.Unix(int64(exp), 0)
	}
	return time.Time{}
}

func clip(b []byte) string {
	s := strings.TrimSpace(string(b))
	if len(s) > 400 {
		return s[:400] + "…"
	}
	return s
}

// flexedInt accepts the interval as either a JSON number or a string, since the
// device endpoint has returned both.
type flexedInt int

func (f *flexedInt) UnmarshalJSON(b []byte) error {
	var n int
	if err := json.Unmarshal(b, &n); err == nil {
		*f = flexedInt(n)
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return err
	}
	var v int
	if _, err := fmt.Sscanf(strings.TrimSpace(s), "%d", &v); err != nil {
		return nil
	}
	*f = flexedInt(v)
	return nil
}

type flexedTime time.Time

func (f *flexedTime) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return nil
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		*f = flexedTime(t)
	}
	return nil
}
