import { useEffect, useState } from 'react';
import { enableWaitlistPush, getPushState, isIOS, isStandalone, PushState } from '../lib/push';

/**
 * "Enable notifications" card for the waitlist customer flow.
 * Reuses the web-push architecture from the order module; the subscription
 * is saved against the waitlist token via POST /api/waitlist/notifications/subscribe.
 */
export default function WaitlistNotify({ token }: { token: string }) {
  const [pushState, setPushState] = useState<PushState>('available');
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [showIOSHint, setShowIOSHint] = useState(false);

  useEffect(() => {
    getPushState().then(setPushState);
    isIOS().then(async (ios) => {
      if (ios && !(await isStandalone())) setShowIOSHint(true);
    });
  }, []);

  const onEnablePush = async () => {
    setPushBusy(true);
    setPushMsg(null);
    const r = await enableWaitlistPush(token);
    setPushMsg(r.message);
    if (r.ok) setPushState('subscribed');
    else setPushState(await getPushState());
    setPushBusy(false);
  };

  if (pushState === 'subscribed') {
    return <div className="ok">🔔 Notifications on — we'll alert you when your table is almost ready.</div>;
  }

  return (
    <div className="card">
      <h2>🔔 Get notified</h2>
      <p className="sub">We'll notify you when your table is almost ready and when it's your turn.</p>
      {showIOSHint && (
        <div className="info">
          On iPhone, push notifications work best if you add this page to your Home Screen first
          (Share → Add to Home Screen), then tap the button below.
        </div>
      )}
      {pushState === 'denied' ? (
        <div className="info">
          Notifications are blocked for this site. You can still watch your place in line update live on this page.
        </div>
      ) : pushState === 'unsupported' ? (
        <div className="info">
          This browser doesn't support push notifications — this page still updates live automatically.
        </div>
      ) : (
        <button className="btn block" onClick={onEnablePush} disabled={pushBusy}>
          {pushBusy ? 'Enabling…' : '🔔 Enable Notifications'}
        </button>
      )}
      {pushMsg && <div className={pushMsg.startsWith("You're") ? 'ok' : 'info'}>{pushMsg}</div>}
    </div>
  );
}
