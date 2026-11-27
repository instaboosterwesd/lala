"use client";

import * as React from "react";

import { CheckIcon, CopyIcon, ExternalLinkIcon, Loader2Icon, LogOutIcon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { ChatGPTDeviceCode, ChatGPTModel, ChatGPTStatus } from "@/lib/types";

// ChatGPT sign-in, Codex-style: the server asks OpenAI for a one-time code, the
// user approves it at auth.openai.com, and this card polls until the account is
// connected — no API key is ever typed or pasted.
export function ChatGPTConnect({ onChanged }: { onChanged?: () => void }) {
  const [status, setStatus] = React.useState<ChatGPTStatus | null>(null);
  const [models, setModels] = React.useState<ChatGPTModel[]>([]);
  const [loadingModels, setLoadingModels] = React.useState(false);
  const [savingModel, setSavingModel] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [disconnecting, setDisconnecting] = React.useState(false);
  const [code, setCode] = React.useState<ChatGPTDeviceCode | null>(null);
  const [copied, setCopied] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const next = await api.chatGPTStatus();
      setStatus(next);
      if (next.connected) {
        setLoadingModels(true);
        try {
          const available = await api.chatGPTModels();
          setModels(available);
          if (available.length > 0 && !available.some((model) => model.id === next.model)) {
            await api.chatGPTSetModel(available[0].id);
            setStatus({ ...next, model: available[0].id });
          }
        } catch (e) {
          setModels([]);
          toast.error(`Could not load ChatGPT models: ${(e as Error).message}`);
        } finally {
          setLoadingModels(false);
        }
      } else {
        setModels([]);
      }
    } catch {
      /* the card simply stays in its loading state */
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function start() {
    setStarting(true);
    try {
      const c = await api.chatGPTStart();
      setCode(c);
      // Open the approval page in a new tab; the code is copied to the clipboard so
      // pasting it there is one keystroke.
      window.open(c.verification_url, "_blank", "noopener,noreferrer");
      void copyCode(c.user_code);
    } catch (e) {
      toast.error(`Could not start sign-in: ${(e as Error).message}`);
    } finally {
      setStarting(false);
    }
  }

  async function copyCode(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked (insecure origin): the code is on screen anyway */
    }
  }

  // Poll while a login is pending. Stops as soon as the account connects, the
  // dialog closes, or the code expires.
  React.useEffect(() => {
    if (!code) return;
    let cancelled = false;
    const interval = Math.max(3, code.interval || 5) * 1000;
    const expires = Date.parse(code.expires_at);
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      if (!Number.isNaN(expires) && Date.now() > expires) {
        setCode(null);
        toast.error("The sign-in code expired; start again.");
        return;
      }
      try {
        const r = await api.chatGPTPoll(code.device_auth_id, code.user_code);
        if (cancelled) return;
        if (r.status === "connected") {
          setCode(null);
          setStatus(r);
          toast.success(r.email ? `Connected as ${r.email}` : "ChatGPT connected");
          void reload();
          onChanged?.();
        }
      } catch (e) {
        if (cancelled) return;
        setCode(null);
        toast.error(`Sign-in failed: ${(e as Error).message}`);
      }
    }, interval);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [code, onChanged, reload]);

  async function disconnect() {
    setDisconnecting(true);
    try {
      await api.chatGPTDisconnect();
      toast.success("ChatGPT disconnected");
      await reload();
      onChanged?.();
    } catch (e) {
      toast.error(`Disconnect failed: ${(e as Error).message}`);
    } finally {
      setDisconnecting(false);
    }
  }

  async function chooseModel(model: string) {
    if (!model || model === status?.model) return;
    setSavingModel(true);
    try {
      await api.chatGPTSetModel(model);
      setStatus((current) => current ? { ...current, model } : current);
      toast.success(`Model changed to ${models.find((item) => item.id === model)?.name ?? model}`);
      onChanged?.();
    } catch (e) {
      toast.error(`Could not change model: ${(e as Error).message}`);
    } finally {
      setSavingModel(false);
    }
  }

  const connected = status?.connected === true;

  return (
    <>
      <Card className={connected ? "border-emerald-500/40 bg-emerald-500/5" : "border-dashed"}>
        <CardContent className="flex flex-wrap items-center gap-4 px-4 py-4">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <SparklesIcon className={connected ? "mt-0.5 size-5 shrink-0 text-emerald-500" : "mt-0.5 size-5 shrink-0 text-muted-foreground"} />
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-sm">ChatGPT</span>
                {connected ? (
                  <Badge variant="outline" className="border-emerald-500/50 text-emerald-600 dark:text-emerald-400">
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="outline">Not connected</Badge>
                )}
                {connected && status?.plan && <Badge variant="secondary">{status.plan}</Badge>}
              </div>
              <p className="text-muted-foreground text-xs">
                {connected ? (
                  <>
                    Signed in{status?.email ? ` as ${status.email}` : ""} · model <span className="font-mono">{status?.model}</span> · the
                    access token refreshes on its own.
                  </>
                ) : (
                  <>
                    Sign in with your ChatGPT account: a one-time code is shown here, you approve it in the browser, and this server keeps
                    the session. No API key involved.
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {connected ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void start()} disabled={starting}>
                  {starting ? <Loader2Icon className="animate-spin" /> : null} Reconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void disconnect()} disabled={disconnecting}>
                  {disconnecting ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />} Disconnect
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => void start()} disabled={starting}>
                {starting ? <Loader2Icon className="animate-spin" /> : null} Connect ChatGPT
              </Button>
            )}
          </div>
          {connected && (
            <div className="flex w-full flex-wrap items-center gap-2 border-t pt-3">
              <label htmlFor="chatgpt-model" className="text-muted-foreground text-xs">Subscription model</label>
              <select
                id="chatgpt-model"
                value={status?.model ?? ""}
                onChange={(event) => void chooseModel(event.target.value)}
                disabled={loadingModels || savingModel || models.length === 0}
                className="h-9 min-w-56 rounded-md border bg-background px-3 text-sm"
              >
                {loadingModels && <option value="">Loading available models…</option>}
                {!loadingModels && models.length === 0 && <option value="">No models available</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </select>
              {savingModel && <Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
              <span className="text-muted-foreground text-xs">Only models available to your account are listed.</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={code !== null} onOpenChange={(o) => !o && setCode(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve this sign-in</DialogTitle>
            <DialogDescription>
              Enter the code below at the OpenAI page that just opened. This window finishes on its own once you approve.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <button
              type="button"
              onClick={() => code && void copyCode(code.user_code)}
              className="flex items-center justify-center gap-2 rounded-md border bg-muted px-4 py-3 font-mono text-2xl tracking-widest"
              title="Copy the code"
            >
              {code?.user_code}
              {copied ? <CheckIcon className="size-4 text-emerald-500" /> : <CopyIcon className="size-4 opacity-60" />}
            </button>
            <a
              href={code?.verification_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 text-primary text-sm underline-offset-4 hover:underline"
            >
              {code?.verification_url} <ExternalLinkIcon className="size-3.5" />
            </a>
            <p className="flex items-center justify-center gap-2 text-muted-foreground text-xs">
              <Loader2Icon className="size-3.5 animate-spin" /> Waiting for approval…
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
