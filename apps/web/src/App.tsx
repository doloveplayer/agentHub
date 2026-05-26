import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAppStore } from './store/appStore';
import { ChatPage } from './pages/ChatPage';
import { LoginPage } from './components/LoginPage';
import { AuthCallback } from './components/AuthCallback';
import { ToastContainer } from './components/ToastContainer';

export function App() {
  const token = useAppStore((s) => s.token);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={token ? <ChatPage /> : <Navigate to="/login" />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}
