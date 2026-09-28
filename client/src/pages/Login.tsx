import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { api, saveSession } from '../lib/api';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ token: string; user: any }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      saveSession(data.token, data.user);
      navigate('/staff');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="card" style={{ marginTop: 40 }}>
        <h1>Staff log in</h1>
        <p className="sub">Counter and kitchen staff sign in here.</p>
        {error && <div className="error">{error}</div>}
        <form onSubmit={submit}>
          <label className="field">
            <span>Username</span>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <button className="btn block" disabled={busy}>
            {busy ? 'Signing in…' : 'Log in'}
          </button>
        </form>
      </div>
      <p className="sub" style={{ textAlign: 'center' }}>
        <Link className="link" to="/">← Back to home</Link>
      </p>
    </div>
  );
}
