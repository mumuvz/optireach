import type { BusinessProfile } from './local';
// API contract types shared by the Express API (response builders) and the React client.
// Dates are ISO-8601 strings on the wire.
import type {
  AgencyBillingMode,
  AgencyLinkStatus,
  ApprovalEntityType,
  ApprovalStatus,
  AuditSchedule,
  BackgroundJobType,
  JobStatus,
  PlatformRole,
  TaskPriority,
  TaskStatus,
  TaskType,
  WorkspaceRole,
} from './enums';
import type { MembershipVia } from './permissions';
import type { NotificationPrefs } from './schemas/auth';
import type { CrawlSettings } from './schemas/project';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ApiSuccess<T> {
  data: T;
  meta?: PageMeta;
}

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PLAN_LIMIT_REACHED',
  'RATE_LIMITED',
  'CSRF_INVALID',
  'PAYLOAD_TOO_LARGE',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_DISABLED',
  'PROVIDER_NOT_CONFIGURED',
  'UNSUPPORTED_TARGET',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  /** An external provider (for example a Google API) refused or failed the request; the message says why. */
  'UPSTREAM_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/** Field-level validation detail returned with VALIDATION_ERROR. */
export interface ValidationIssue {
  path: string;
  message: string;
}

export interface UserDto {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  platformRole: PlatformRole;
  notificationPrefs: NotificationPrefs;
  deletionRequestedAt: string | null;
  createdAt: string;
}

export interface MembershipDto {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  /** Effective role: the membership role, or the role inherited through an agency. */
  role: WorkspaceRole;
  /** DIRECT membership, or AGENCY when the workspace is a client of one of the user's agency workspaces. */
  via: MembershipVia;
  agencyWorkspaceId: string | null;
  /** The client allowed the agency to decide approvals (only meaningful when via is AGENCY). */
  approvalsDelegated: boolean;
}

export interface MeDto {
  user: UserDto;
  memberships: MembershipDto[];
  currentWorkspaceId: string | null;
}

export interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  via: MembershipVia;
  /** The platform's managed-services provider workspace (can manage client workspaces without a plan limit). */
  isServiceProvider: boolean;
  whiteLabel: {
    enabled: boolean;
    brandName?: string;
    accentColor?: string;
    logoUrl?: string;
    supportEmail?: string;
    hidePoweredBy?: boolean;
  } | null;
  createdAt: string;
}

export interface WorkspaceMemberDto {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface InvitationDto {
  id: string;
  email: string;
  role: WorkspaceRole;
  expiresAt: string;
  createdAt: string;
  invitedBy: string | null;
}

export interface CompetitorDto {
  id: string;
  name: string;
  /** Null for a local competitor without a known website. */
  domain: string | null;
  aliases: string[];
  notes: string | null;
  kind: 'WEBSITE' | 'LOCAL';
  status: 'SUGGESTED' | 'CONFIRMED' | 'DISMISSED';
  source: 'MANUAL' | 'DISCOVERED';
  locationId: string | null;
  placeId: string | null;
  category: string | null;
  address: string | null;
  /** Map position when known (from a linked place or discovery); used to show the competitor on a map. */
  latitude: number | null;
  longitude: number | null;
  /** Publicly displayed rating and review count when last observed (with lastSeenAt). */
  rating: number | null;
  reviewCount: number | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ProjectSummaryDto {
  id: string;
  workspaceId: string;
  name: string;
  /** Null for a business without a website. */
  websiteUrl: string | null;
  domain: string | null;
  industry: string | null;
  isDemo: boolean;
  createdAt: string;
  latestScore: number | null;
  latestAuditAt: string | null;
}

export interface ProjectDto extends ProjectSummaryDto {
  description: string | null;
  targetCountries: string[];
  targetLanguages: string[];
  brandVoice: string | null;
  brandAliases: string[];
  crawlSettings: CrawlSettings;
  auditSchedule: AuditSchedule;
  nextAuditAt: string | null;
  competitors: CompetitorDto[];
  primaryKeywords: string[];
  businessProfile: BusinessProfile;
  updatedAt: string;
}

export interface JobDto {
  id: string;
  type: BackgroundJobType;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  entityType: string | null;
  entityId: string | null;
  result: unknown;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Returned with 202 Accepted when work is queued. */
export interface QueuedJobDto {
  jobId: string;
  status: JobStatus;
  entityId?: string;
}

export interface ProviderStatusDto {
  key: string;
  label: string;
  kind: string;
  configured: boolean;
  status: 'configured' | 'not_configured' | 'demo' | 'disabled';
  detail: string;
}

// ---------------- Integration diagnostics ----------------

/** ok: working. warning: usable but degraded or missing. error: broken, needs action. off: not set up. */
export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'off';

export interface DiagnosticCheck {
  key: string;
  title: string;
  category: 'connections' | 'ai' | 'local' | 'infrastructure';
  status: DiagnosticStatus;
  detail: string;
  /** What this capability enables, for context. */
  enables: string | null;
  /** How to fix it when the status is not ok. */
  fix: string | null;
  /** In-app link to act on it, when relevant. */
  link: string | null;
}

export interface IntegrationDiagnosticsDto {
  checks: DiagnosticCheck[];
  summary: { ok: number; warning: number; error: number; off: number };
  generatedAt: string;
}

// ---------------- Approvals, tasks, agency ----------------

export interface UserRefDto {
  id: string;
  name: string;
}

export interface ApprovalRequestDto {
  id: string;
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  entityType: ApprovalEntityType;
  entityId: string;
  title: string;
  summary: string | null;
  status: ApprovalStatus;
  requestedBy: UserRefDto | null;
  requestedAt: string;
  decidedBy: UserRefDto | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedVia: string | null;
  dueAt: string | null;
  /** Whether the current user may decide this request. */
  canDecide: boolean;
}

export interface ApprovalRequestDetailDto extends ApprovalRequestDto {
  snapshot: unknown;
  snapshotHash: string;
  /** Earlier and later requests for the same record, newest first. */
  history: Pick<ApprovalRequestDto, 'id' | 'status' | 'requestedAt' | 'decidedAt' | 'decisionNote'>[];
}

export interface TaskDto {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  type: TaskType;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: UserRefDto | null;
  dueDate: string | null;
  periodKey: string | null;
  clientVisible: boolean;
  entityType: string | null;
  entityId: string | null;
  createdBy: UserRefDto | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Logged time in minutes. */
  minutesLogged: number;
}

export interface TimeEntryDto {
  id: string;
  user: UserRefDto | null;
  minutes: number;
  workDate: string;
  note: string | null;
  createdAt: string;
}

export interface AgencyLinkDto {
  id: string;
  agencyWorkspaceId: string;
  agencyName: string;
  clientWorkspaceId: string;
  clientName: string;
  status: AgencyLinkStatus;
  accessRole: WorkspaceRole;
  approvalsDelegated: boolean;
  billingMode: AgencyBillingMode;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface ProviderRateDto {
  id: string;
  provider: string;
  operation: string | null;
  unit: string;
  /** Price in currency units for `unitQuantity` units. */
  price: number;
  unitQuantity: number;
  currency: string;
  effectiveFrom: string;
  note: string | null;
}

export interface ProviderCostLineDto {
  provider: string;
  operation: string;
  calls: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost per currency (currency units), from configured rates. */
  cost: Record<string, number>;
  /** Calls without a configured rate; their cost is unknown, not zero. */
  unpricedCalls: number;
}
