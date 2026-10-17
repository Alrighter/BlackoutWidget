import { createRoot } from 'react-dom/client';
import { WidgetRoot } from './WidgetRoot';
import './widget.css';

createRoot(document.getElementById('root')!).render(<WidgetRoot api={window.api} />);
