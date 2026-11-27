"use client";

import * as React from "react";
import { Loader2Icon, SparklesIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import type { LiquidDecisionModel } from "@/lib/types";

const DEFAULT_STATE = "Help! My payouts have been failing for 3 days.";
const DEFAULT_QUESTIONS = JSON.stringify(
  {
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    is_urgent: { type: "noul", instructions: "Does this convey urgency?" },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
  null,
  2,
);

export default function LiquidDecisionsPage() {
  const [models, setModels] = React.useState<LiquidDecisionModel[]>([]);
  const [model, setModel] = React.useState("d1");
  const [state, setState] = React.useState(DEFAULT_STATE);
  const [questions, setQuestions] = React.useState(DEFAULT_QUESTIONS);
  const [result, setResult] = React.useState<Record<string, unknown> | null>(null);
  const [error, setError] = React.useState("");
  const [loadingModels, setLoadingModels] = React.useState(true);
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    api.liquidDecisionModels()
      .then((items) => {
        if (!alive) return;
        setModels(items);
        if (items.length > 0 && !items.some((item) => item.name === "d1")) setModel(items[0].name);
      })
      .catch((e: unknown) => {
        if (alive) setError((e as Error).message || "Liquid AI is not configured.");
      })
      .finally(() => alive && setLoadingModels(false));
    return () => { alive = false; };
  }, []);

  async function runDecision() {
    setRunning(true);
    setResult(null);
    setError("");
    try {
      const parsed = JSON.parse(questions) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Questions must be a JSON object keyed by question name.");
      }
      const response = await api.liquidDecide({ model, state, questions: parsed as Parameters<typeof api.liquidDecide>[0]["questions"] });
      setResult(response);
    } catch (e) {
      const message = (e as Error).message || "Decision request failed.";
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-6 p-4 md:p-6">
      <div className="grid gap-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight"><SparklesIcon className="size-5" />Liquid Decisions</h1>
        <p className="text-muted-foreground text-sm">Ask Liquid AI decision models typed choice, yes/no, and score questions about text or structured data.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run a decision</CardTitle>
          <CardDescription>The API key stays on the server. Configure it as <code>LIQUID_API_KEY</code> in the service environment.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5">
          {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">{error}</div>}
          <div className="grid gap-2">
            <Label htmlFor="liquid-model">Decision model</Label>
            <select
              id="liquid-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={loadingModels || models.length === 0}
              className="h-9 w-full max-w-md rounded-md border bg-background px-3 text-sm"
            >
              {loadingModels && <option value="d1">Loading models…</option>}
              {models.map((item) => <option key={item.name} value={item.name}>{item.name}{item.description ? ` — ${item.description}` : ""}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="liquid-state">State to analyze</Label>
            <Textarea id="liquid-state" rows={4} value={state} onChange={(event) => setState(event.target.value)} placeholder="Paste a message, record, or other context…" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="liquid-questions">Questions (JSON)</Label>
            <Textarea id="liquid-questions" rows={15} value={questions} onChange={(event) => setQuestions(event.target.value)} className="font-mono text-xs" spellCheck={false} />
            <p className="text-muted-foreground text-xs">Supported types: <code>choice</code> with object criteria, <code>score</code> with an array of levels, and <code>noul</code> for yes/no.</p>
          </div>
          <div>
            <Button onClick={() => void runDecision()} disabled={running || loadingModels || models.length === 0 || !state.trim()}>
              {running && <Loader2Icon className="animate-spin" />} Run decision
            </Button>
          </div>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader><CardTitle>Decision result</CardTitle></CardHeader>
          <CardContent><pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs">{JSON.stringify(result, null, 2)}</pre></CardContent>
        </Card>
      )}
    </div>
  );
}
