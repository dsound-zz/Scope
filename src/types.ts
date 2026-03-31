/**
 * SCOPE — Shared Type Definitions
 */

export interface JobLead {
  /** Unique identifier — derived from URL hash or slug */
  id: string;
  title: string;
  company: string;
  url: string;
  score?: number;
  snippet?: string;
}

export interface MatchedJob extends JobLead {
  score: number;
  matchReason: string;
}

export interface ContactResult {
  company: string;
  /** Job title the contact was matched for */
  jobTitle?: string;
  contactName?: string | null;
  linkedInUrl?: string | null;
  contactRole?: string | null;
}
