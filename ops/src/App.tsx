import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Cases } from './pages/Cases';
import { Exceptions } from './pages/Exceptions';
import { CaseDetail } from './pages/CaseDetail';
import { CaseActionView } from './pages/CaseActionView';
import { PartsHandoff } from './pages/PartsHandoff';
import { PaymentHandoff } from './pages/PaymentHandoff';
import { NetworkMap } from './pages/NetworkMap';
import { IntegrationHealth } from './pages/IntegrationHealth';
import { NotificationOperations } from './pages/NotificationOperations';
import { FinancialOperations } from './pages/FinancialOperations';

function CaseControl() {
  return (
    <div className="space-y-4">
      <CaseActionView />
      <details className="rounded-xl border border-slate-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700">Case tools & details</summary>
        <div className="border-t border-slate-200 p-4">
          <CaseDetail />
          <div className="mt-6 space-y-6">
            <PartsHandoff />
            <PaymentHandoff />
          </div>
        </div>
      </details>
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Cases />} />
              <Route path="/exceptions" element={<Exceptions />} />
              <Route path="/integrations" element={<IntegrationHealth />} />
              <Route path="/notifications" element={<NotificationOperations />} />
              <Route path="/financials" element={<FinancialOperations />} />
              <Route path="/map" element={<NetworkMap />} />
              <Route path="/cases/:id" element={<CaseControl />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
