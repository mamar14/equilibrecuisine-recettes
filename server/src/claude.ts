/** Appel à l'API Messages de Claude avec sortie JSON structurée (output_config.format). */
import type { Env } from "./env.ts";
import { ApiError, Errors } from "./http.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

export interface ClaudeRequest {
  system: string;
  content: ContentBlock[];
  schema: Record<string, unknown>;
  maxTokens: number;
}

export async function claudeJson<T>(env: Env, req: ClaudeRequest): Promise<T> {
  if (!env.ANTHROPIC_API_KEY) throw Errors.upstream("IA non configurée sur le serveur.");
  const base = env.ANTHROPIC_API_BASE ?? "https://api.anthropic.com";
  let res: Response;
  try {
    res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || "claude-haiku-5-5",
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.content }],
        output_config: { format: { type: "json_schema", schema: req.schema } }
      }),
      signal: AbortSignal.timeout(90_000)
    });
  } catch (e) {
    console.error("Claude injoignable", e);
    throw Errors.upstream("L'IA ne répond pas, réessayez dans un instant.");
  }
  if (!res.ok) {
    const body = await res.text();
    console.error("Claude", res.status, body.slice(0, 500));
    if (res.status === 429 || res.status === 529 || res.status >= 500) throw Errors.upstream("L'IA est très sollicitée, réessayez dans un instant.");
    throw Errors.upstream("L'IA n'a pas pu traiter la demande.");
  }
  const body = (await res.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (body.stop_reason === "refusal") {
    throw new ApiError(422, "refused", "L'IA a refusé cette demande. Reformulez-la autrement.");
  }
  if (body.stop_reason === "max_tokens") throw Errors.upstream("Réponse de l'IA incomplète, réessayez.");
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error("JSON IA illisible", text.slice(0, 300));
    throw Errors.upstream("Réponse de l'IA illisible, réessayez.");
  }
}
