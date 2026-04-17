import { useEffect, useRef, useState } from 'react';
import {
  Invitation,
  Inviter,
  Registerer,
  Session,
  SessionState,
  UserAgent,
  URI,
} from 'sip.js';
import './App.css';

const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
  sipWebsocket: import.meta.env.VITE_SIP_WSS_URL ?? 'wss://pbx.example.com:8089/ws',
  sipDomain: import.meta.env.VITE_SIP_DOMAIN ?? 'pbx.example.com',
  sipUsername: import.meta.env.VITE_SIP_USERNAME ?? 'venus',
  sipPassword: import.meta.env.VITE_SIP_PASSWORD ?? 'change_me',
  turnUrl: import.meta.env.VITE_TURN_URL ?? 'turn:pbx.example.com:3478?transport=udp',
  turnUsername: import.meta.env.VITE_TURN_USERNAME ?? 'webrtc-user',
  turnPassword: import.meta.env.VITE_TURN_PASSWORD ?? 'webrtc-password',
};

const OUTGOING_NUMBERS = [
  '0290178400',
  '0290178401',
  '0290178402',
  '0290178426',
];

function formatAuNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('02')) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)} ${digits.slice(6)}`;
  }
  return raw;
}

function App() {
  const [outgoingNumber, setOutgoingNumber] = useState(OUTGOING_NUMBERS[0]);
  const [dialNumber, setDialNumber] = useState('');
  const [incomingNumber, setIncomingNumber] = useState('');
  const [status, setStatus] = useState('Connecting...');
  const [isRegistered, setIsRegistered] = useState(false);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string>();

  const userAgentRef = useRef<UserAgent | undefined>(undefined);
  const registererRef = useRef<Registerer | undefined>(undefined);
  const activeSessionRef = useRef<Session | undefined>(undefined);
  const inboundInviteRef = useRef<Invitation | undefined>(undefined);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const registeredRef = useRef(false);

  const consultant = config.sipUsername;

  // --- Helpers ---

  const bindMedia = (session: Session) => {
    const handler = session.sessionDescriptionHandler as {
      peerConnection?: RTCPeerConnection;
    };
    const pc = handler?.peerConnection;
    const audio = remoteAudioRef.current;
    if (!pc || !audio) return;

    const stream = new MediaStream();
    pc.getReceivers().forEach((r) => {
      if (r.track) stream.addTrack(r.track);
    });
    audio.srcObject = stream;
    audio.play().catch(() => null);
  };

  const pushEvent = async (
    eventType: 'inbound' | 'oncall' | 'disconnected' | 'DNDon' | 'DNDoff',
    payload: Record<string, unknown>,
  ) => {
    try {
      await fetch(`${config.apiBaseUrl}/v1/asterisk/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, ...payload }),
      });
    } catch {
      /* backend may be offline during dev */
    }
  };

  // --- Outbound call session tracking ---

  const attachSessionEvents = (
    session: Session,
    callId: string,
    phoneNumber: string,
  ) => {
    session.stateChange.addListener((state) => {
      if (state === SessionState.Establishing) {
        setStatus('Ringing...');
      }
      if (state === SessionState.Established) {
        setStatus('Call active');
        void pushEvent('oncall', {
          callId,
          consultant,
          phoneNumber,
          outgoingNumber,
          direction: 'outbound',
          status: 'answered',
        });
        bindMedia(session);
      }
      if (state === SessionState.Terminated) {
        setStatus('Call ended');
        void pushEvent('disconnected', {
          callId,
          consultant,
          phoneNumber,
          status: 'disconnected',
        });
        activeSessionRef.current = undefined;
        setActiveCallId(undefined);
      }
    });
  };

  // --- Auto-register on mount ---

  useEffect(() => {
    if (registeredRef.current) return;
    registeredRef.current = true;

    const register = async () => {
      const uri = UserAgent.makeURI(
        `sip:${consultant}@${config.sipDomain}`,
      );
      if (!uri) {
        setStatus('Invalid SIP configuration');
        return;
      }

      try {
        const ua = new UserAgent({
          uri,
          authorizationUsername: consultant,
          authorizationPassword: config.sipPassword,
          transportOptions: { server: config.sipWebsocket },
          sessionDescriptionHandlerFactoryOptions: {
            peerConnectionConfiguration: {
              iceServers: [
                {
                  urls: [config.turnUrl],
                  username: config.turnUsername,
                  credential: config.turnPassword,
                },
              ],
            },
          },
          delegate: {
            onInvite: handleIncomingCall,
          },
        });

        const reg = new Registerer(ua);
        await ua.start();
        await reg.register();

        userAgentRef.current = ua;
        registererRef.current = reg;
        setIsRegistered(true);
        setStatus('Ready');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        setStatus(`Offline: ${msg}`);
        setIsRegistered(false);
      }
    };

    register();

    return () => {
      registererRef.current?.unregister().catch(() => null);
      userAgentRef.current?.stop().catch(() => null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Incoming call handler ---

  function handleIncomingCall(invitation: Invitation) {
    inboundInviteRef.current = invitation;
    const caller = invitation.remoteIdentity.uri.user ?? 'unknown';
    setIncomingNumber(caller);
    setStatus(`Incoming call from ${caller}`);

    const callId = crypto.randomUUID();
    setActiveCallId(callId);

    void pushEvent('inbound', {
      callId,
      consultant,
      phoneNumber: caller,
      direction: 'inbound',
      status: 'ringing',
    });

    invitation.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        setStatus('Incoming call active');
        bindMedia(invitation);
      }
      if (state === SessionState.Terminated) {
        setStatus('Ready');
        void pushEvent('disconnected', {
          callId,
          consultant,
          phoneNumber: caller,
          status: 'disconnected',
        });
        inboundInviteRef.current = undefined;
        setIncomingNumber('');
        setActiveCallId(undefined);
      }
    });
  }

  // --- Actions ---

  const dial = async () => {
    if (!isRegistered || !userAgentRef.current || !dialNumber.trim()) return;

    const target = UserAgent.makeURI(
      `sip:${dialNumber}@${config.sipDomain}`,
    );
    if (!target) {
      setStatus('Invalid phone number');
      return;
    }

    const callId = crypto.randomUUID();
    setActiveCallId(callId);

    const inviter = new Inviter(userAgentRef.current, target as URI);
    activeSessionRef.current = inviter;
    attachSessionEvents(inviter, callId, dialNumber);

    setStatus(`Dialing ${dialNumber}...`);
    await pushEvent('oncall', {
      callId,
      consultant,
      phoneNumber: dialNumber,
      outgoingNumber,
      direction: 'outbound',
      status: 'ringing',
    });
    await inviter.invite();
  };

  const answer = async () => {
    if (!inboundInviteRef.current) return;
    await inboundInviteRef.current.accept();
  };

  const reject = async () => {
    if (!inboundInviteRef.current) return;
    await inboundInviteRef.current.reject();
    setStatus('Ready');
  };

  const hangup = async () => {
    const session = activeSessionRef.current ?? inboundInviteRef.current;
    if (!session) return;

    if (session.state === SessionState.Established) {
      await session.bye();
    } else if (session instanceof Inviter) {
      await session.cancel();
    } else if (session instanceof Invitation) {
      await session.reject();
    }
  };

  const toggleDnd = async () => {
    const next = !dndEnabled;
    setDndEnabled(next);
    try {
      await fetch(`${config.apiBaseUrl}/v1/dnd/${consultant}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
    } catch {
      /* backend may be offline */
    }
    await pushEvent(next ? 'DNDon' : 'DNDoff', { consultant });
    setStatus(next ? 'DND enabled' : 'Ready');
  };

  const isOnCall = !!activeCallId;

  // --- UI ---

  return (
    <main className="app">
      <h1>Web Calling Console</h1>

      <div className="status-bar">
        <span className={`status-dot ${isRegistered ? 'online' : 'offline'}`} />
        <span className="status-text">{status}</span>
        <span className="consultant-name">{consultant}</span>
      </div>

      <section className="card">
        <h2>Make a Call</h2>

        <label>
          Call from
          <select
            value={outgoingNumber}
            onChange={(e) => setOutgoingNumber(e.target.value)}
            disabled={isOnCall}
          >
            {OUTGOING_NUMBERS.map((num) => (
              <option key={num} value={num}>
                {formatAuNumber(num)}
              </option>
            ))}
          </select>
        </label>

        <label>
          Call to
          <input
            type="tel"
            placeholder="e.g. 0414313767"
            value={dialNumber}
            onChange={(e) => setDialNumber(e.target.value)}
            disabled={isOnCall}
          />
        </label>

        <div className="actions">
          <button
            className="btn-dial"
            onClick={dial}
            disabled={!isRegistered || isOnCall || !dialNumber.trim()}
          >
            Dial
          </button>
          <button
            className="btn-hangup"
            onClick={hangup}
            disabled={!isOnCall}
          >
            Hangup
          </button>
        </div>
      </section>

      {incomingNumber && (
        <section className="card card-incoming">
          <h2>Incoming Call</h2>
          <p className="caller-id">{formatAuNumber(incomingNumber)}</p>
          <div className="actions">
            <button className="btn-accept" onClick={answer}>
              Accept
            </button>
            <button className="btn-reject" onClick={reject}>
              Reject
            </button>
          </div>
        </section>
      )}

      <section className="card card-dnd">
        <div className="dnd-row">
          <span>Do Not Disturb</span>
          <button
            className={dndEnabled ? 'btn-dnd-on' : 'btn-dnd-off'}
            onClick={toggleDnd}
            disabled={!isRegistered}
          >
            {dndEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      </section>

      <audio ref={remoteAudioRef} autoPlay />
    </main>
  );
}

export default App;
