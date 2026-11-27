package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const liquidAPIBase = "https://api.liquid.ai/decisions/v1"

type liquidDecisionModel struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	ReleaseDate string   `json:"release_date,omitempty"`
	Modalities  []string `json:"input_modalities,omitempty"`
}

type liquidDecisionQuestion struct {
	Type         string          `json:"type"`
	Instructions string          `json:"instructions"`
	Criteria     json.RawMessage `json:"criteria,omitempty"`
}

type liquidDecisionInput struct {
	Model     string                             `json:"model"`
	State     string                             `json:"state"`
	Questions map[string]liquidDecisionQuestion `json:"questions"`
}

func liquidAPIKey() string { return strings.TrimSpace(os.Getenv("LIQUID_API_KEY")) }

func (s *Server) liquidDecisionModels(w http.ResponseWriter, r *http.Request) {
	key := liquidAPIKey()
	if key == "" {
		writeErr(w, http.StatusServiceUnavailable, "Liquid Decisions is not configured. Set LIQUID_API_KEY in the server environment.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	models, status, err := fetchLiquidModels(ctx, key)
	if err != nil {
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func (s *Server) liquidDecisionRun(w http.ResponseWriter, r *http.Request) {
	key := liquidAPIKey()
	if key == "" {
		writeErr(w, http.StatusServiceUnavailable, "Liquid Decisions is not configured. Set LIQUID_API_KEY in the server environment.")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var input liquidDecisionInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid request body: "+err.Error())
		return
	}
	if err := validateLiquidDecisionInput(input); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	models, status, err := fetchLiquidModels(ctx, key)
	if err != nil {
		writeErr(w, status, err.Error())
		return
	}
	available := false
	for _, model := range models {
		if model.Name == input.Model {
			available = true
			break
		}
	}
	if !available {
		writeErr(w, http.StatusBadRequest, "model is not available to this Liquid API account")
		return
	}
	body, err := json.Marshal(input)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "could not encode decision request")
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, liquidAPIBase+"/systemone", bytes.NewReader(body))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "could not create Liquid request")
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		writeErr(w, http.StatusBadGateway, "Liquid request failed: "+err.Error())
		return
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		writeErr(w, http.StatusBadGateway, "could not read Liquid response")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(raw)
}

func fetchLiquidModels(ctx context.Context, key string) ([]liquidDecisionModel, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, liquidAPIBase+"/models", nil)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := (&http.Client{Timeout: 20 * time.Second}).Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("could not load Liquid models: %w", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("could not read Liquid model list")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, http.StatusBadGateway, fmt.Errorf("Liquid model list returned HTTP %d", resp.StatusCode)
	}
	var result struct {
		Models []liquidDecisionModel `json:"models"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("could not parse Liquid model list")
	}
	if len(result.Models) == 0 {
		return nil, http.StatusBadGateway, fmt.Errorf("Liquid returned no decision models")
	}
	return result.Models, http.StatusOK, nil
}

func validateLiquidDecisionInput(in liquidDecisionInput) error {
	if strings.TrimSpace(in.Model) == "" {
		return fmt.Errorf("choose a decision model")
	}
	if len(in.State) > 100_000 {
		return fmt.Errorf("state is too long (maximum 100,000 characters)")
	}
	if len(in.Questions) == 0 || len(in.Questions) > 20 {
		return fmt.Errorf("provide between 1 and 20 questions")
	}
	for name, question := range in.Questions {
		if strings.TrimSpace(name) == "" || len(name) > 100 {
			return fmt.Errorf("question names must be 1–100 characters")
		}
		if strings.TrimSpace(question.Instructions) == "" {
			return fmt.Errorf("question %q needs instructions", name)
		}
		switch question.Type {
		case "noul":
		case "choice":
			var criteria map[string]string
			if len(question.Criteria) == 0 || json.Unmarshal(question.Criteria, &criteria) != nil || len(criteria) < 2 {
				return fmt.Errorf("question %q needs at least two choice criteria", name)
			}
		case "score":
			var criteria []string
			if len(question.Criteria) == 0 || json.Unmarshal(question.Criteria, &criteria) != nil || len(criteria) < 2 {
				return fmt.Errorf("question %q needs at least two score criteria", name)
			}
		default:
			return fmt.Errorf("question %q type must be choice, score, or noul", name)
		}
	}
	return nil
}
