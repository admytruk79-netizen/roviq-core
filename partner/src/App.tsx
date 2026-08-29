import { AuthProvider, useAuth } from './auth';
import { Dashboard } from './Dashboard';
import { LocalMap } from './LocalMap';
import { Login } from './Login';

function Portal() {
  const { principal } = useAuth();
  return principal ? <><Dashboard /><LocalMap /></> : <Login />;
}

export default function App() {
  return (
    <AuthProvider>
      <Portal />
    </AuthProvider>
  );
}
