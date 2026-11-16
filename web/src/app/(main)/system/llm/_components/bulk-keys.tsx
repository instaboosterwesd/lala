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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { LLMProfile } from "@/lib/types";

// Both gateways speak the OpenAI wire format, so the only per-provider difference is the
// base URL, the key prefix used to recognise it, and a free default model.
const PROVIDERS = {
  openrouter: {
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    freeModel: "inclusionai/ling-3.2-flash:free",
    prefixes: ["sk-or-"],
    hint: "Free models are the ones priced at 0 on OpenRouter (…:free).",
  },
  "google-ai-studio": {
    label: "Google AI Studio",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    freeModel: "gemini-2.5-flash",
    prefixes: ["AIza"],
    hint: "gemini-2.5-flash is on the free tier of the AI Studio API.",
  },
} as const;

type ProviderKey = keyof typeof PROVIDERS;

const PROVIDER_KEYS = Object.keys(PROVIDERS) as ProviderKey[];

// A pasted key is routed by its prefix, so one box can take OpenRouter and AI Studio keys
// mixed together. Anything unrecognised is reported instead of being saved as a broken
// profile.
function detectProvider(key: string): ProviderKey | null {
  for (const p of PROVIDER_KEYS) {
    if (PROVIDERS[p].prefixes.some((prefix) => key.startsWith(prefix))) return p;
  }
  return null;
}

// Accept keys separated by newlines, commas, semicolons or spaces (people paste them in
// every shape) and drop duplicates, so a double paste does not create duplicate profiles.
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

// Profile names must be unique (the database enforces it), so importing the same provider
// again continues the numbering instead of colliding with "OpenRouter 1".
function uniqueName(label: string, start: number, taken: Set<string>): string {
  let n = start;
  let name = `${label} ${n}`;
  while (taken.has(name)) {
    n++;
    name = `${label} ${n}`;
  }
  taken.add(name);
  return name;
}

type FreeModel = { id: string; ctx: number };

// The OpenRouter catalogue is public and CORS-open, so the free list can be read straight
// from the browser: pricing both 0 = free, and "tools" support is required for the agent to
// be able to call anything.
async function fetchOpenRouterFreeModels(): Promise<FreeModel[]> {
  const res = await fetch("https://openrouter.ai/api/v1/models");
  if (!res.ok) throw new Error(`model list HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      id?: string;
      pricing?: { prompt?: string; completion?: string };
      context_length?: number;
      supported_parameters?: string[];
    }[];
  };
  const free = (body.data ?? []).filter(
    (m) =>
      m?.id &&
      m.pricing?.prompt === "0" &&
      m.pricing?.completion === "0" &&
      (m.supported_parameters ?? []).includes("tools"),
  );
  free.sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0));
  return free.slice(0, 40).map((m) => ({ id: m.id as string, ctx: m.context_length ?? 0 }));
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
  const [raw, setRaw] = React.useState("");
  const [models, setModels] = React.useState<Record<ProviderKey, string>>({
    openrouter: PROVIDERS.openrouter.freeModel,
    "google-ai-studio": PROVIDERS["google-ai-studio"].freeModel,
  });
  const [freeModels, setFreeModels] = React.useState<FreeModel[]>([]);
  const [loadingFree, setLoadingFree] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Reopening starts clean; the free catalogue is fetched once per open (it is cheap).
  React.useEffect(() => {
    if (!open) return;
    setRaw("");
    setModels({
      openrouter: PROVIDERS.openrouter.freeModel,
      "google-ai-studio": PROVIDERS["google-ai-studio"].freeModel,
    });
    setBusy(false);
    setLoadingFree(true);
    fetchOpenRouterFreeModels()
      .then((list) => {
        setFreeModels(list);
        // Prefer the catalogue's top free model over the built-in fallback.
        if (list.length > 0) setModels((prev) => ({ ...prev, openrouter: list[0].id }));
      })
      .catch(() => {
        /* keep the built-in free default */
      })
      .finally(() => setLoadingFree(false));
  }, [open]);

  const keys = React.useMemo(() => parseKeys(raw), [raw]);

  // One bucket per provider, filled in paste order, plus the keys we could not place.
  const grouped = React.useMemo(() => {
    const buckets: Record<ProviderKey, string[]> = { openrouter: [], "google-ai-studio": [] };
    const unknown: string[] = [];
    keys.forEach((key, i) => {
      const p = detectProvider(key);
      if (p)
        buckets[p].push(`${i}`); // remember the paste position for the failover order
      else unknown.push(key);
    });
    return { buckets, unknown };
  }, [keys]);

  const detected = PROVIDER_KEYS.filter((p) => grouped.buckets[p].length > 0);
  const total = detected.reduce((n, p) => n + grouped.buckets[p].length, 0);

  async function importKeys() {
    if (total === 0 || busy) return;
    setBusy(true);
    const taken = new Set(profiles.map((p) => p.name));
    const created: { id: string; name: string }[] = [];
    const failed: string[] = [];
    try {
      // Paste order is failover order: the key pasted first gets the highest priority, so it
      // leads the chain and an exhausted / rate-limited key hands over to the next one.
      const order: { provider: ProviderKey; key: string; idx: number }[] = [];
      for (const p of detected) {
        for (const idx of grouped.buckets[p]) order.push({ provider: p, key: keys[Number(idx)], idx: Number(idx) });
      }
      order.sort((a, b) => a.idx - b.idx);

      const counters: Record<ProviderKey, number> = { openrouter: 1, "google-ai-studio": 1 };
      for (const item of order) {
        const cfg = PROVIDERS[item.provider];
        const model = models[item.provider].trim() || cfg.freeModel;
        const name = uniqueName(cfg.label, counters[item.provider], taken);
        counters[item.provider]++;
        try {
          const { id } = await api.saveLLMProfile({
            name,
            format: "openai",
            model,
            base_url: cfg.baseUrl,
            api_key: item.key,
            priority: order.length - item.idx,
            pool_exclude: false,
            streaming: true,
          });
          created.push({ id: String(id), name });
        } catch (e) {
          failed.push(`${name}: ${(e as Error).message}`);
        }
      }

      // Nothing active yet → activate the first imported key, otherwise the app keeps saying
      // "No LLM configured yet" and no request ever runs.
      let activated = false;
      if (created.length > 0 && !profiles.some((p) => p.is_default)) {
        try {
          await api.activateLLMProfile(created[0].id);
          activated = true;
        } catch {
          /* the card's "Set as active" button stays available */
        }
      }

      // Failover only happens while the pool is on; with more than one key that is the whole
      // point of this dialog, so switch it on instead of making it a separate step.
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
        toast.success(`Added ${created.length} profile${created.length === 1 ? "" : "s"}`, {
          description: extras.length > 0 ? extras.join(" · ") : undefined,
        });
      }
      if (failed.length > 0) {
        toast.error(`${failed.length} key${failed.length === 1 ? "" : "s"} failed`, { description: failed.join("; ") });
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
            Paste any mix of keys — each one is recognised by its prefix and saved under the right provider. Every key
            becomes its own profile in the failover chain, so when one runs out of credit or gets rate-limited the next
            one takes over.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bulk-keys">API keys</Label>
              <span className="text-muted-foreground text-xs">
                {total > 0
                  ? `${total} detected${detected.length > 0 ? ` · ${detected.map((p) => `${PROVIDERS[p].label} ${grouped.buckets[p].length}`).join(", ")}` : ""}`
                  : "paste OpenRouter (sk-or-…) and AI Studio (AIza…) keys together"}
              </span>
            </div>
            <Textarea
              id="bulk-keys"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"One key per line — mixing providers is fine\nsk-or-v1-…\nAIza…"}
              className="min-h-32 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            {grouped.unknown.length > 0 && (
              <p className="text-destructive text-xs">
                {grouped.unknown.length} key{grouped.unknown.length === 1 ? "" : "s"} not recognised (expected sk-or-…
                or AIza…): {grouped.unknown.slice(0, 2).join(", ")}
                {grouped.unknown.length > 2 ? "…" : ""}
              </p>
            )}
          </div>

          {detected.map((p) => {
            const cfg = PROVIDERS[p];
            const listId = `free-models-${p}`;
            return (
              <div key={p} className="grid gap-1.5 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor={`bulk-model-${p}`} className="text-xs">
                    {cfg.label} · {grouped.buckets[p].length} key{grouped.buckets[p].length === 1 ? "" : "s"}
                  </Label>
                  {p === "openrouter" && loadingFree && (
                    <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                  )}
                </div>
                <Input
                  id={`bulk-model-${p}`}
                  value={models[p]}
                  onChange={(e) => setModels((prev) => ({ ...prev, [p]: e.target.value }))}
                  placeholder={cfg.freeModel}
                  list={p === "openrouter" && freeModels.length > 0 ? listId : undefined}
                  className="font-mono"
                />
                {p === "openrouter" && freeModels.length > 0 && (
                  <datalist id={listId}>
                    {freeModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.ctx > 0 ? `${Math.round(m.ctx / 1000)}K ctx` : ""}
                      </option>
                    ))}
                  </datalist>
                )}
                <p className="text-muted-foreground text-xs">{cfg.hint}</p>
              </div>
            );
          })}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void importKeys()} disabled={busy || total === 0}>
            {busy && <Loader2Icon className="animate-spin" />}
            Add {total > 0 ? total : ""} key{total === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
