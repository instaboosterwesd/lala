package server

import (
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/Autumn-27/artex/agent"
	"github.com/Autumn-27/artex/codexauth"
	"github.com/Autumn-27/artex/db"
)

// ChatGPT subscription sign-in: the LLM page shows a one-time code, the user
// approves it at auth.openai.com/codex/device, and this server keeps the tokens
// (see package codexauth). Requests for the resulting profile are stamped with
// those OAuth credentials by the provider transport, so no API key is involved.

const chatGPTProfileName = "ChatGPT"

// codex returns the process-wide token store, creating it on first use.
func (s *Server) codex() *codexauth.Store {
	s.codexMu.Lock()
	defer s.codexMu.Unlock()
	if s.codexStore == nil {
		s.codexStore = codexauth.NewStore(s.m.pg)
	}
	return s.codexStore
}

// isChatGPTProfile reports whether a profile points at the subscription backend
// (rather than an API-key endpoint), which is what makes it OAuth-authenticated.
func isChatGPTProfile(p *db.LLMProfile) bool {
	if p == nil {
		return false
	}
	base := strings.ToLower(strings.TrimSpace(p.BaseURL))
	return strings.Contains(base, "chatgpt.com/backend-api/codex")
}

// sameProviderConfig reports whether two configs describe the same provider, for
// reusing one cached provider (and its rate limiter). A ChatGPT profile's APIKey
// is a rotating OAuth token, so two OAuth configs compare equal on everything but
// the token.
func sameProviderConfig(a, b agent.Config) bool {
	if a.Format != b.Format || a.BaseURL != b.BaseURL || a.Model != b.Model || a.Proxy != b.Proxy {
		return false
	}
	if a.CodexToken != nil || b.CodexToken != nil {
		return a.CodexToken != nil && b.CodexToken != nil
	}
	return a.APIKey == b.APIKey && a.Stream == b.Stream && a.MaxTokens == b.MaxTokens &&
		a.MaxTokensField == b.MaxTokensField && a.ReasoningEffort == b.ReasoningEffort &&
		a.ThinkingType == b.ThinkingType
}

// applyCodexAuth makes a ChatGPT profile authenticate with the stored OAuth
// session: the transport gets a live token source (refreshed per request) and the
// config gets a current token, so the "needs an API key" check passes.
func (s *Server) applyCodexAuth(cfg *agent.Config, p *db.LLMProfile) {
	if !isChatGPTProfile(p) {
		return
	}
	// Profiles created by the first ChatGPT connect flow used a model that the
	// subscription backend rejects. Correct it on use as well as in storage.
	if cfg.Model == "gpt-5-codex" {
		cfg.Model = codexauth.DefaultModel
	}
	cfg.CodexToken = s.codex().AccessToken
	if tok, _, err := cfg.CodexToken(context.Background()); err == nil {
		cfg.APIKey = tok
	}
}

// chatGPTStatusBody is the shape the LLM page polls: connected + who is signed in.
func (s *Server) chatGPTStatusBody() map[string]any {
	store := s.codex()
	t, ok := store.Status()
	body := map[string]any{
		"connected": ok,
		"base_url":  codexauth.BaseURL,
		"model":     codexauth.DefaultModel,
	}
	if !ok {
		return body
	}
	body["email"] = t.Email
	body["plan"] = t.Plan
	body["account_id"] = t.AccountID
	body["expires_at"] = t.ExpiresAt
	if s.m.pg != nil {
		if ps, err := s.m.pg.ListProfiles(); err == nil {
			for _, p := range ps {
				if isChatGPTProfile(p) {
					if p.Model == "gpt-5-codex" {
						p.Model = codexauth.DefaultModel
						if id, saveErr := s.m.pg.SaveProfile(p); saveErr == nil {
							body["profile_id"] = id
							s.invalidateProfileAgents()
							s.reapplyActiveProfile()
						}
					}
					body["profile_id"] = p.ID
					body["profile_name"] = p.Name
					body["model"] = p.Model
					break
				}
			}
		}
	}
	return body
}

// pgChatGPTStatus reports the connected account (or connected=false).
func (s *Server) pgChatGPTStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, s.chatGPTStatusBody())
}

// pgChatGPTModels returns the account-specific catalogue from the Codex backend.
func (s *Server) pgChatGPTModels(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	models, err := s.codex().Models(ctx)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

// pgChatGPTSetModel only accepts a slug returned by the authenticated catalogue.
func (s *Server) pgChatGPTSetModel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Model string `json:"model"`
	}
	if err := decode(r, &body); err != nil || strings.TrimSpace(body.Model) == "" {
		writeErr(w, http.StatusBadRequest, "model is required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	models, err := s.codex().Models(ctx)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	valid := false
	for _, model := range models {
		if model.ID == body.Model {
			valid = true
			break
		}
	}
	if !valid {
		writeErr(w, http.StatusBadRequest, "model is not available for this ChatGPT account")
		return
	}
	if s.m.pg == nil {
		writeErr(w, http.StatusServiceUnavailable, "profile storage is unavailable")
		return
	}
	profiles, err := s.m.pg.ListProfiles()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, profile := range profiles {
		if !isChatGPTProfile(profile) {
			continue
		}
		profile.Model = body.Model
		if _, err := s.m.pg.SaveProfile(profile); err != nil {
			writeErr(w, http.StatusInternalServerError, err.Error())
			return
		}
		s.invalidateProfileAgents()
		s.reapplyActiveProfile()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "model": body.Model})
		return
	}
	writeErr(w, http.StatusNotFound, "ChatGPT profile not found; reconnect ChatGPT")
}

// pgChatGPTStart hands the UI a fresh device code to display.
func (s *Server) pgChatGPTStart(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	code, err := s.codex().StartDevice(ctx)
	if err != nil {
		log.Printf("[chatgpt] start sign-in: %v", err)
		writeErr(w, 502, err.Error())
		return
	}
	writeJSON(w, 200, code)
}

// pgChatGPTPoll checks one poll of the pending login. On approval it also creates
// (or refreshes) the ChatGPT profile and makes it the active one, so chat works
// immediately after connecting.
func (s *Server) pgChatGPTPoll(w http.ResponseWriter, r *http.Request) {
	var body struct {
		DeviceAuthID string `json:"device_auth_id"`
		UserCode     string `json:"user_code"`
	}
	if err := decode(r, &body); err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if body.DeviceAuthID == "" || body.UserCode == "" {
		writeErr(w, 400, "device_auth_id and user_code are required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	pending, tokens, err := s.codex().PollDevice(ctx, body.DeviceAuthID, body.UserCode)
	if err != nil {
		log.Printf("[chatgpt] poll sign-in: %v", err)
		writeErr(w, 502, err.Error())
		return
	}
	if pending {
		writeJSON(w, 200, map[string]any{"status": "pending"})
		return
	}
	if _, err := s.ensureChatGPTProfile(tokens); err != nil {
		log.Printf("[chatgpt] save profile: %v", err)
		writeErr(w, 500, "signed in, but saving the LLM profile failed: "+err.Error())
		return
	}
	status := s.chatGPTStatusBody()
	status["status"] = "connected"
	writeJSON(w, 200, status)
}

// pgChatGPTDisconnect forgets the tokens. The profile stays (so a re-connect
// reuses it) but stops working until the user signs in again.
func (s *Server) pgChatGPTDisconnect(w http.ResponseWriter, r *http.Request) {
	if err := s.codex().Clear(); err != nil {
		writeErr(w, 500, err.Error())
		return
	}
	s.invalidateProfileAgents()
	s.reapplyActiveProfile()
	writeJSON(w, 200, map[string]any{"ok": true, "connected": false})
}

// ensureChatGPTProfile creates or refreshes the profile that carries the
// subscription connection, then activates it.
func (s *Server) ensureChatGPTProfile(t *codexauth.Tokens) (int64, error) {
	if s.m.pg == nil {
		return 0, nil
	}
	prof := &db.LLMProfile{
		Name:           chatGPTProfileName,
		Format:         "openai-responses",
		BaseURL:        codexauth.BaseURL,
		Model:          codexauth.DefaultModel,
		APIKey:         t.AccessToken,
		Streaming:      true,
		ContextWindowK: 272,
	}
	if ps, err := s.m.pg.ListProfiles(); err == nil {
		for _, p := range ps {
			if isChatGPTProfile(p) || strings.EqualFold(p.Name, chatGPTProfileName) {
				// Keep the user's own model/streaming choices on a re-connect.
				prof.ID = p.ID
				prof.Streaming = p.Streaming
				if strings.TrimSpace(p.Model) != "" && p.Model != "gpt-5-codex" {
					prof.Model = p.Model
				}
				if p.ContextWindowK > 0 {
					prof.ContextWindowK = p.ContextWindowK
				}
				break
			}
		}
	}
	id, err := s.m.pg.SaveProfile(prof)
	if err != nil {
		return 0, err
	}
	if err := s.m.pg.SetActiveProfile(id); err != nil {
		return id, err
	}
	s.invalidateProfileAgents()
	s.reapplyActiveProfile()
	return id, nil
}
