// Records stored on disk and the state carried between graph nodes.

export type Route = 'smalltalk' | 'memory_only' | 'clarify' | 'search' | 'recheck';
export type Verdict = 'held' | 'changed' | 'corrected' | 'could-not-verify';
export type TurnStatus = 'complete' | 'cancelled' | 'error';

/** A web result we showed or used. `id` is the `S#` the writer cites. */
export type Source = {
  id: string;
  url: string;
  title: string;
  pageDate?: string; // YYYY-MM-DD when the provider reports one
  excerpt: string; // what the page said, as we held it
  complete: boolean; // true when the excerpt is the full page text, not a cut snippet
};

export type Evidence = { sentence: string; sourceId: string; excerpt: string };

export type Turn = {
  id: string;
  convId: string;
  userId?: string; // browser-held ID that groups a person's conversations (no login)
  seq: number;
  ts: string; // server ISO timestamp
  tz: string; // IANA zone from the browser
  localDay: string; // YYYY-MM-DD in the user's zone
  user: string;
  assistant?: string;
  route: Route;
  status: TurnStatus;
  sources: Source[];
  evidence: Evidence[];
};

export type Claim = {
  id: string; // hash(turnId, entity, attribute) so re-extraction upserts
  turnId: string;
  day: string; // local day of the turn that made it
  entity: string;
  attribute: string;
  value: string;
  sourceUrl: string;
  pageDate?: string;
  supersedes?: string;
};

export type DateWindow = { start: string; end: string; label: string };

export type Resolved = {
  window: DateWindow | null;
  candidates: string[]; // ordered days to try first
  vague: boolean;
  eventAnchored: boolean;
  assumption?: string; // e.g. "read 3/11 as 3 November (day-first)"
};

export type RecallStatus = 'found' | 'ask' | 'none' | 'skipped';
export type RecallHit = { turn: Turn; score: number; how: string };
export type Recall = {
  status: RecallStatus;
  hits: RecallHit[];
  matchedDay?: string;
  widened: number;
  daysAvailable: string[];
};

export type Finding = {
  entity: string;
  summary: string;
  sources: Source[];
  error?: string; // "could not check X"
};

export type VerdictRow = {
  claimId: string;
  entity: string;
  attribute: string;
  oldValue: string;
  newValue?: string;
  verdict: Verdict;
  evidence: string[]; // source IDs
  note?: string;
};

export type Flag = { kind: 'guard' | 'cancelled' | 'budget' | 'error' | 'info'; message: string };

/** Events sent to the browser over SSE. */
export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'sources'; sources: Pick<Source, 'id' | 'url' | 'title' | 'pageDate'>[] }
  | { type: 'token'; text: string }
  | { type: 'note'; text: string }
  | { type: 'done'; turnId: string; route: Route; day: string }
  | { type: 'error'; message: string };

export type Emit = (e: AgentEvent) => void;
