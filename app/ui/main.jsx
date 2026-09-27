import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import App from './App';
import { applyTheme, useNightMode } from './theme';
import './index.css';

function ToasterMatchingTheme() {
  const nightMode = useNightMode();
  return <Toaster theme={nightMode ? 'dark' : 'light'} position="bottom-right" offset={{ bottom: 44, right: 16 }} />;
}

applyTheme();
createRoot(document.getElementById('root')).render(
  <TooltipProvider delayDuration={400}>
    <App />
    <ToasterMatchingTheme />
  </TooltipProvider>,
);
