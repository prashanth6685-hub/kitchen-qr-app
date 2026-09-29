import { Routes, Route, Link, Navigate, useNavigate } from 'react-router-dom';
import { getUser, clearSession } from './lib/api';
import Login from './pages/Login';
import StaffDashboard from './pages/StaffDashboard';
import NewOrder from './pages/NewOrder';
import StaffOrderDetail from './pages/StaffOrderDetail';
import KitchenDisplay from './pages/KitchenDisplay';
import CustomerOrder from './pages/CustomerOrder';
import CheckIn from './pages/CheckIn';
import WaitTracking from './pages/WaitTracking';
import WaitlistAdmin from './pages/WaitlistAdmin';

function TopBar() {
  const user = getUser();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <div className="topbar">
      <div className="brand">
        <span>●</span> Kitchen Orders
      </div>
      <nav>
        <span className="who">
          {user.username} · {user.role.replace('_', ' ')}
        </span>
        <Link className="link" to="/staff">Orders</Link>
        <Link className="link" to="/staff/waitlist">Waitlist</Link>
        {(user.role === 'ADMIN' || user.role === 'COUNTER_STAFF') && (
          <Link className="link" to="/staff/new">+ New</Link>
        )}
        <Link className="link" to="/kitchen">Kitchen</Link>
        <button
          className="btn secondary"
          style={{ minHeight: 36, padding: '6px 12px', fontSize: 13 }}
          onClick={() => {
            clearSession();
            navigate('/login');
          }}
        >
          Log out
        </button>
      </nav>
    </div>
  );
}

function RequireStaff({ children }: { children: JSX.Element }) {
  if (!getUser()) return <Navigate to="/login" replace />;
  return children;
}

function Home() {
  const user = getUser();
  return (
    <div className="page">
      <div className="card" style={{ textAlign: 'center', marginTop: 40 }}>
        <h1>Kitchen Orders</h1>
        <p className="sub">QR-based counter ordering with live customer notifications.</p>
        <div className="btn-row" style={{ justifyContent: 'center' }}>
          {user ? (
            <>
              <Link className="btn" to="/staff">Staff dashboard</Link>
              <Link className="btn secondary" to="/staff/waitlist">Waitlist</Link>
              <Link className="btn secondary" to="/kitchen">Kitchen display</Link>
            </>
          ) : (
            <Link className="btn" to="/login">Staff log in</Link>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <>
      <TopBar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/order/:token" element={<CustomerOrder />} />
        <Route path="/checkin/:slug" element={<CheckIn />} />
        <Route path="/wait/:token" element={<WaitTracking />} />
        <Route
          path="/staff/waitlist"
          element={
            <RequireStaff>
              <WaitlistAdmin />
            </RequireStaff>
          }
        />
        <Route
          path="/staff"
          element={
            <RequireStaff>
              <StaffDashboard />
            </RequireStaff>
          }
        />
        <Route
          path="/staff/new"
          element={
            <RequireStaff>
              <NewOrder />
            </RequireStaff>
          }
        />
        <Route
          path="/staff/orders/:id"
          element={
            <RequireStaff>
              <StaffOrderDetail />
            </RequireStaff>
          }
        />
        <Route
          path="/kitchen"
          element={
            <RequireStaff>
              <KitchenDisplay />
            </RequireStaff>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
