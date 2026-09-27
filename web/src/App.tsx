import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Cases } from './pages/Cases';
import { NewDemand } from './pages/NewDemand';
import { CaseDetail } from './pages/CaseDetail';
import { Local } from './pages/Local';
import { Inventory } from './pages/Inventory';
import { NotFound } from './pages/NotFound';
import { CoreCases } from './pages/CoreCases';
import { CoreCaseDetail } from './pages/CoreCaseDetail';

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Layout />}>
            <Route path="/inventory" element={<Inventory />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/" element={<Cases />} />
              <Route path="/cases/new" element={<NewDemand />} />
              <Route path="/core-cases" element={<CoreCases />} />
              <Route path="/core-cases/:id" element={<CoreCaseDetail />} />
              <Route path="/cases/:id" element={<CaseDetail />} />
              <Route path="/local" element={<Local />} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
