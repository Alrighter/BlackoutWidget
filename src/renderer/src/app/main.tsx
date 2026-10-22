import { createRoot } from 'react-dom/client';
import type { MainView } from '../../../shared/ipc';
import { App } from './App';
import './app.css';

// Main loads the window with ?view=…&location=… (main-window.ts); later views come as navigate events.
const query = new URLSearchParams(window.location.search);
const raw = query.get('view');
const view: MainView = raw === 'settings' || raw === 'setup' ? raw : 'schedule';
const locationId = query.get('location') ?? undefined;

createRoot(document.getElementById('root')!).render(<App api={window.api} view={view} locationId={locationId} />);
