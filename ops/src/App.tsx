import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { Cases } from './pages/Cases';
import { Exceptions } from './pages/Exceptions';
import { CaseDetail } from './pages/CaseDetail';
import { NetworkMap } from './pages/NetworkMap';

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
              <Route path="/map" element={<NetworkMap />} />
              <Route path="/cases/:id" element={<CaseDetail />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
