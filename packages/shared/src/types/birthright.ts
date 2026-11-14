/** What the Birthright interview streams to the page, one event per server-sent message. */
export type BirthrightControlEvent =
  | { type: "text"; delta: string }
  | { type: "facet"; key: string; value: string }
  | { type: "choice"; options: string[] }
  | { type: "soul_start"; name: string; description: string }
  | { type: "soul_delta"; delta: string }
  | { type: "soul_end" }
  | { type: "profile_delta"; delta: string }
  | { type: "profile_end" };

export type BirthrightEvent =
  | BirthrightControlEvent
  | { type: "session"; id: string }
  | { type: "done" }
  | { type: "error"; message: string };

/** The body of POST /api/birthright/birth: the rite's one result. */
export interface BirthrightBirth {
  name: string;
  description: string;
  content: string;
  profile?: string;
  voice?: string;
}

export interface BirthrightTrialAnswer {
  source: "new" | "current";
  text: string;
}

export interface BirthrightTrial {
  current: string | null;
  rounds: Array<{ message: string; answers: BirthrightTrialAnswer[] }>;
}
