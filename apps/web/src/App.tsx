import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import { MarketingLayout } from '@/components/marketing/layout';
import { FullPageSpinner, SessionWatcher } from '@/lib/auth';
import {
  AcceptInvitationPage,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from '@/pages/auth/auth-pages';
import { BlogIndexPage, BlogPostPage } from '@/pages/marketing/blog';
import ContactPage from '@/pages/marketing/contact';
import { FeatureDetailPage, FeaturesPage } from '@/pages/marketing/features';
import FreeAuditPage from '@/pages/marketing/free-audit';
import HomePage from '@/pages/marketing/home';
import HowItWorksPage from '@/pages/marketing/how-it-works';
import PricingPage from '@/pages/marketing/pricing';
import {
  AboutPage,
  NotFoundPage,
  PrivacyPage,
  ResourcesPage,
  TermsPage,
} from '@/pages/marketing/simple-pages';

// The dashboard is a separate chunk: marketing pages never download it.
const AppRoutes = lazy(() => import('@/app/app-routes'));

export function App() {
  return (
    <>
      <SessionWatcher />
      <Routes>
        <Route element={<MarketingLayout />}>
          <Route index element={<HomePage />} />
          <Route path="features" element={<FeaturesPage />} />
          <Route path="features/seo-audit" element={<FeatureDetailPage feature="seo-audit" />} />
          <Route path="features/ai-visibility" element={<FeatureDetailPage feature="ai-visibility" />} />
          <Route path="features/content-studio" element={<FeatureDetailPage feature="content-studio" />} />
          <Route
            path="features/competitor-analysis"
            element={<FeatureDetailPage feature="competitor-analysis" />}
          />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="how-it-works" element={<HowItWorksPage />} />
          <Route path="resources" element={<ResourcesPage />} />
          <Route path="blog" element={<BlogIndexPage />} />
          <Route path="blog/category/:category" element={<BlogIndexPage />} />
          <Route path="blog/:slug" element={<BlogPostPage />} />
          <Route path="about" element={<AboutPage />} />
          <Route path="contact" element={<ContactPage />} />
          <Route path="free-audit" element={<FreeAuditPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
        <Route path="login" element={<LoginPage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="forgot-password" element={<ForgotPasswordPage />} />
        <Route path="reset-password" element={<ResetPasswordPage />} />
        <Route path="verify-email" element={<VerifyEmailPage />} />
        <Route path="invite/accept" element={<AcceptInvitationPage />} />
        <Route
          path="app/*"
          element={
            <Suspense fallback={<FullPageSpinner />}>
              <AppRoutes />
            </Suspense>
          }
        />
      </Routes>
      <Toaster position="bottom-right" richColors closeButton />
    </>
  );
}
