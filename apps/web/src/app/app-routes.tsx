import { lazy } from 'react';
import { Route, Routes } from 'react-router';
import { RequireAdmin, RequireAuth } from '@/lib/auth';
import { ProjectScope } from './project-scope';
import { AppShell } from './shell';

// Each page is its own chunk.
const AppHome = lazy(() => import('@/pages/app/home'));
const ProjectsPage = lazy(() => import('@/pages/app/projects'));
const NewProjectPage = lazy(() => import('@/pages/app/project-new'));
const OverviewPage = lazy(() => import('@/pages/app/overview'));
const LocalOverviewPage = lazy(() => import('@/pages/app/local-overview'));
const RankTrackerPage = lazy(() => import('@/pages/app/rank-tracker'));
const BusinessProfilePage = lazy(() => import('@/pages/app/business-profile'));
const MerchantPage = lazy(() => import('@/pages/app/merchant'));
const LocationsPage = lazy(() => import('@/pages/app/locations'));
const AuditsPage = lazy(() => import('@/pages/app/audits'));
const AuditDetailPage = lazy(() => import('@/pages/app/audit-detail'));
const PageDetailPage = lazy(() => import('@/pages/app/page-detail'));
const IssuesPage = lazy(() => import('@/pages/app/issues'));
const IssueDetailPage = lazy(() => import('@/pages/app/issue-detail'));
const VisibilityPage = lazy(() => import('@/pages/app/visibility'));
const ObservationPage = lazy(() => import('@/pages/app/observation'));
const KeywordsPage = lazy(() => import('@/pages/app/keywords'));
const LocalPostsPage = lazy(() => import('@/pages/app/local-posts'));
const ContentPage = lazy(() => import('@/pages/app/content'));
const ContentEditorPage = lazy(() => import('@/pages/app/content-editor'));
const AnswerabilityPage = lazy(() => import('@/pages/app/answerability'));
const CompetitorsPage = lazy(() => import('@/pages/app/competitors'));
const GapAnalysisPage = lazy(() => import('@/pages/app/gap-analysis'));
const SeoComparisonPage = lazy(() => import('@/pages/app/seo-comparison'));
const TrendsPage = lazy(() => import('@/pages/app/trends'));
const RecommendationsPage = lazy(() => import('@/pages/app/recommendations'));
const ReportsPage = lazy(() => import('@/pages/app/reports'));
const ReportViewerPage = lazy(() => import('@/pages/app/report-viewer'));
const IntegrationsPage = lazy(() => import('@/pages/app/integrations'));
const IntegrationsLanding = lazy(() => import('@/pages/app/integrations-landing'));
const ProjectSettingsPage = lazy(() => import('@/pages/app/project-settings'));
const BillingPage = lazy(() => import('@/pages/app/billing'));
const SettingsPage = lazy(() => import('@/pages/app/settings'));
const AdminPage = lazy(() => import('@/pages/app/admin'));
const ApprovalsPage = lazy(() => import('@/pages/app/approvals'));
const ApprovalDetailPage = lazy(() =>
  import('@/pages/app/approvals').then((m) => ({ default: m.ApprovalDetailPage })),
);
const TasksPage = lazy(() => import('@/pages/app/tasks'));
const TaskDetailPage = lazy(() => import('@/pages/app/tasks').then((m) => ({ default: m.TaskDetailPage })));
const AgencyPage = lazy(() => import('@/pages/app/agency'));
const AppNotFound = lazy(() => import('@/pages/app/not-found'));

export default function AppRoutes() {
  return (
    <Routes>
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<AppHome />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/new" element={<NewProjectPage />} />
          <Route path="p/:projectId" element={<ProjectScope />}>
            <Route index element={<OverviewPage />} />
            <Route path="audits" element={<AuditsPage />} />
            <Route path="seo-comparison" element={<SeoComparisonPage />} />
            <Route path="trends" element={<TrendsPage />} />
            <Route path="local" element={<LocalOverviewPage />} />
            <Route path="local/rank" element={<RankTrackerPage />} />
            <Route path="local/profile" element={<BusinessProfilePage />} />
            <Route path="local/posts" element={<LocalPostsPage />} />
            <Route path="local/merchant" element={<MerchantPage />} />
            <Route path="locations" element={<LocationsPage />} />
            <Route path="audits/:auditId" element={<AuditDetailPage />} />
            <Route path="audits/:auditId/pages/:pageId" element={<PageDetailPage />} />
            <Route path="issues" element={<IssuesPage />} />
            <Route path="issues/:issueId" element={<IssueDetailPage />} />
            <Route path="visibility" element={<VisibilityPage />} />
            <Route path="visibility/observations/:observationId" element={<ObservationPage />} />
            <Route path="gaps" element={<GapAnalysisPage />} />
            <Route path="keywords" element={<KeywordsPage />} />
            <Route path="content" element={<ContentPage />} />
            <Route path="content/:documentId" element={<ContentEditorPage />} />
            <Route path="answerability" element={<AnswerabilityPage />} />
            <Route path="competitors" element={<CompetitorsPage />} />
            <Route path="recommendations" element={<RecommendationsPage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:reportId" element={<ReportViewerPage />} />
            <Route path="integrations" element={<IntegrationsPage />} />
            <Route path="settings" element={<ProjectSettingsPage />} />
            <Route path="*" element={<AppNotFound />} />
          </Route>
          <Route path="integrations" element={<IntegrationsLanding />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="approvals/:approvalId" element={<ApprovalDetailPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="tasks/:taskId" element={<TaskDetailPage />} />
          <Route path="agency" element={<AgencyPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route element={<RequireAdmin />}>
            <Route path="admin" element={<AdminPage />} />
          </Route>
          <Route path="*" element={<AppNotFound />} />
        </Route>
      </Route>
    </Routes>
  );
}
