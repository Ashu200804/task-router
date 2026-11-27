import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { session } from './api.ts';
import { App } from './App.tsx';
import { PersonApp } from './PersonApp.tsx';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {session.read() ? <PersonApp name={session.read()!.name} /> : <App />}
  </StrictMode>,
);
