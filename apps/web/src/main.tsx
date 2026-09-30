import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';
const ReviewApp=React.lazy(()=>import('./review/ReviewApp.js'));
const review=location.pathname==='/review'||location.pathname.startsWith('/review/');
document.title=review?'Проверка источников':'Check Право';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{review?<React.Suspense fallback={<main className="launch-screen">Загружаем...</main>}><ReviewApp/></React.Suspense>:<App/>}</React.StrictMode>
);
