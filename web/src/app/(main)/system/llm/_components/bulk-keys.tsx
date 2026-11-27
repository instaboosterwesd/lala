"use client";

import * as React from "react";

import { ExternalLinkIcon, KeyRoundIcon, Loader2Icon } from "lucide-react";
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

// Deploy speaks the OpenAI wire format, so a profile only needs its base URL and a model.
const PROVIDER = {
  label: "Deploy",
  baseUrl: "https://api.deploy.com/api/v1",
  keysUrl: "https://portal.deploy.com/?api_keys=1",
  defaultModel: "deepseek-ai/deepseek-v4.1-flash-1017",
  // Every model on the account; both take tools, which the agent needs.
  models: ["deepseek-ai/deepseek-v4.1-flash-1017", "zai-org/glm-5.3-flash"],
} as const;

// Accept keys separated by newlines, commas, semicolons or spaces (people paste them in
// every shape) and drop duplicates, so a double paste does not create duplicate profiles.
// A copied "Authorization: Bearer …" header is tolerated too.
function parseKeys(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\s,;]+/)) {
    const key = part.trim().replace(/^Bearer$/i, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

// Profile names must be unique (the database enforces it), so importing again continues the
// numbering instead of colliding with "Deploy 1".
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
  const [model, setModel] = React.useState<string>(PROVIDER.defaultModel);
  const [busy, setBusy] = React.useState(false);

  // Reopening starts clean.
  React.useEffect(() => {
    if (!open) return;
    setRaw("");
    setModel(PROVIDER.defaultModel);
    setBusy(false);
  }, [open]);

  const keys = React.useMemo(() => parseKeys(raw), [raw]);

  async function importKeys() {
    if (keys.length === 0 || busy) return;
    setBusy(true);
    const taken = new Set(profiles.map((p) => p.name));
    const created: { id: string; name: string }[] = [];
    const failed: string[] = [];
    try {
      // Paste order is failover order: the key pasted first leads the chain and hands over to
      // the next one when it runs out of credit or gets rate-limited.
      const name = uniqueName(PROVIDER.label, 1, taken);
      for (const [i, key] of keys.entries()) {
        const profileName = i === 0 ? name : uniqueName(PROVIDER.label, 2, taken);
        try {
          const { id } = await api.saveLLMProfile({
            name: profileName,
            format: "openai",
            model: model.trim() || PROVIDER.defaultModel,
            base_url: PROVIDER.baseUrl,
            api_key: key,
            priority: keys.length - i,
            pool_exclude: false,
            streaming: true,
          });
          created.push({ id: String(id), name: profileName });
        } catch (e) {
          failed.push(`${profileName}: ${(e as Error).message}`);
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
            <KeyRoundIcon className="size-4" /> Paste Deploy keys
          </DialogTitle>
          <DialogDescription>
            Every key becomes its own profile in the failover chain, so when one runs out of credit or gets rate-limited
            the next one takes over. Need another key? Use the button below — it opens your Deploy API keys page.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed p-2.5">
            <span className="text-muted-foreground text-xs">Need a key?</span>
            <Button asChild size="sm" variant="outline">
              <a href={PROVIDER.keysUrl} target="_blank" rel="noreferrer">
                Get Deploy key <ExternalLinkIcon />
              </a>
            </Button>
          </div>

          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="bulk-keys">API keys</Label>
              <span className="text-muted-foreground text-xs">
                {keys.length > 0 ? `${keys.length} key${keys.length === 1 ? "" : "s"} detected` : "one key per line"}
              </span>
            </div>
            <Textarea
              id="bulk-keys"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"One key per line\nF7au…=="}
              className="min-h-32 font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">
              Deploy keys have no fixed prefix — everything pasted here is saved as a Deploy key against{" "}
              <span className="font-mono">{PROVIDER.baseUrl}</span>.
            </p>
          </div>

          <div className="grid gap-1.5 rounded-lg border p-3">
            <Label htmlFor="bulk-model" className="text-xs">
              Model
            </Label>
            <Input
              id="bulk-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={PROVIDER.defaultModel}
              list="deploy-models"
              className="font-mono"
            />
            <datalist id="deploy-models">
              {PROVIDER.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="text-muted-foreground text-xs">
              Both models support tool calling. They think before answering, so keep the output cap generous (≈900+).
            </p>
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
