"use client";

import * as React from "react";

import { KeyRoundIcon, Loader2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { LLMProfile } from "@/lib/types";

// Bulk key import presets. Both gateways speak the OpenAI wire format, which is the only
// thing the backend needs to know: format "openai" + the gateway's base URL + a model id.
// Keys are NOT stored here — only the defaults for a provider are.
const PRESETS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4.5",
    hint: "Keys look like sk-or-v1-…",
  },
  "google-ai-studio": {
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    hint: "AI Studio API keys look like AIza…",
  },
} as const;

type PresetKey = keyof typeof PRESETS;

// Accept keys separated by newlines, commas, semicolons or spaces — people paste them in
// every shape — and drop duplicates, so a double paste does not create duplicate profiles.
function parseKeys(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const key = part.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Profile names must be unique (the database enforces it), so a second import of the same
// provider continues the numbering instead of colliding with "OpenRouter 1".
function uniqueName(label: string, index: number, taken: Set<string>): string {
  let n = index;
  let name = `${label} ${n}`;
  while (taken.has(name)) {
    n++;
    name = `${label} ${n}`;
  }
  taken.add(name);
  return name;
}

export function BulkKeysDialog({
  open,
  onOpenChange,
  profiles,
  poolEnabled,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  profiles: LLMProfile[];
  poolEnabled: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const [preset, setPreset] = React.useState<PresetKey>("openrouter");
  const [model, setModel] = React.useState<string>(PRESETS.openrouter.model);
  const [raw, setRaw] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Reopening starts clean, and switching provider reloads that provider's default model.
  React.useEffect(() => {
    if (!open) return;
    setPreset("openrouter");
    setModel(PRESETS.openrouter.model);
    setRaw("");
    setBusy(false);
  }, [open]);

  const keys = React.useMemo(() => parseKeys(raw), [raw]);
  const cfg = PRESETS[preset];

  async function importKeys() {
    if (keys.length === 0 || busy) return;
    if (!model.trim()) {
      toast.error("Model is required");
      return;
    }
    setBusy(true);
    const taken = new Set(profiles.map((p) => p.name));
    const created: { id: string; name: string }[] = [];
    const failed: string[] = [];
    try {
      for (let i = 0; i < keys.length; i++) {
        const name = uniqueName(cfg.label, i + 1, taken);
        try {
          const { id } = await api.saveLLMProfile({
            name,
            format: "openai",
            model: model.trim(),
            base_url: cfg.baseUrl,
            api_key: keys[i],
            // Higher priority is tried earlier, so the pasted order is the failover order:
            // the first key leads, and when it runs out of credit / gets rate-limited the
            // pool moves to the next one.
            priority: keys.length - i,
            pool_exclude: false,
            streaming: true,
          });
          created.push({ id: String(id), name });
        } catch (e) {
          failed.push(`${name}: ${(e as Error).message}`);
        }
      }

      // Nothing is active yet → activate the first imported key, otherwise the app still
      // reports "No LLM configured yet" and nothing runs.
      let activated = false;
      if (created.length > 0 && !profiles.some((p) => p.is_default)) {
        try {
          await api.activateLLMProfile(created[0].id);
          activated = true;
        } catch {
          /* the card's "Set as active" button stays available */
        }
      }

      // Failover only happens when the pool is on; with more than one key that is the whole
      // point of this dialog, so turn it on once instead of making it a separate step.
      let poolTurnedOn = false;
      if (!poolEnabled && created.length > 1) {
        try {
          await api.setSettings({ llm_pool_enabled: true });
          poolTurnedOn = true;
        } catch {
          /* the pool switch in Pool settings stays available */
        }
      }

      await onSaved();

      if (created.length > 0) {
        const extras = [
          activated ? `activated ${created[0].name}` : null,
          poolTurnedOn ? "failover pool enabled" : null,
        ].filter(Boolean);
        toast.success(`Added ${created.length} ${cfg.label} profile${created.length === 1 ? "" : "s"}`, {
          description: extras.length > 0 ? extras.join(" · ") : undefined,
        });
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} key${failed.length === 1 ? "" : "s"} failed`, {
          description: failed.join("; "),
        });
      }
      if (created.length > 0) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRoundIcon className="size-4" /> Paste keys
          </DialogTitle>
          <DialogDescription>
            One profile per key, all in the failover chain: when a key runs out of credit or gets rate-limited, the next
            one takes over and the work keeps going.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="bulk-preset">Provider</Label>
            <Select
              value={preset}
              onValueChange={(v) => {
                const next = v as PresetKey;
                setPreset(next);
                setModel(PRESETS[next].model);
              }}
            >
              <SelectTrigger id="bulk-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {PRESETS[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Endpoint <code className="font-mono">{cfg.baseUrl}</code>
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="bulk-model">Model</Label>
            <Input
              id="bulk-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={cfg.model}
              className="font-mono"
            />
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bulk-keys">API keys</Label>
              <span className="text-muted-foreground text-xs">
                {keys.length} key{keys.length === 1 ? "" : "s"} detected
              </span>
            </div>
            <Textarea
              id="bulk-keys"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={`${cfg.hint} — one per line (or comma separated)`}
              className="min-h-32 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void importKeys()} disabled={busy || keys.length === 0}>
            {busy && <Loader2Icon className="animate-spin" />}
            Add {keys.length > 0 ? keys.length : ""} key{keys.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
