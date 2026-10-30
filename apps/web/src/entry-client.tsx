import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { createQueryClient } from './lib/query';
import './styles/index.css';

const queryClient = createQueryClient();
const container = document.getElementById('root')!;
const tree = (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);

// Prerendered marketing pages are hydrated; the SPA shell (app.html) starts empty and is mounted.
if (container.firstElementChild) hydrateRoot(container, tree);
else createRoot(container).render(tree);
