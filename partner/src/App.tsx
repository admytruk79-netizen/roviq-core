import { AuthProvider, useAuth } from './auth';
import { Dashboard } from './Dashboard';
import { Login } from './Login';

function Portal() {
  const { principal } = useAuth();
  return principal ? <Dashboard /> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Portal />
    </AuthProvider>
  );
}
