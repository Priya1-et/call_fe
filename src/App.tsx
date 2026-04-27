import { useEffect, useRef, useState } from 'react';
import {
  Invitation,
  Inviter,
  Registerer,
  RegistererState,
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

const OUTGOING_NUMBERS = Array.from(
  { length: 100 },
  (_, i) => `02901784${String(i).padStart(2, '0')}`,
);

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
  const [isOutgoingMenuOpen, setIsOutgoingMenuOpen] = useState(false);
  const [micStatus, setMicStatus] = useState<'unknown' | 'ok' | 'fail'>('unknown');
  const [micDeviceLabel, setMicDeviceLabel] = useState<string>('');

  const userAgentRef = useRef<UserAgent | undefined>(undefined);
  const registererRef = useRef<Registerer | undefined>(undefined);
  const activeSessionRef = useRef<Session | undefined>(undefined);
  const inboundInviteRef = useRef<Invitation | undefined>(undefined);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const registeredRef = useRef(false);
  const outgoingMenuRef = useRef<HTMLDivElement>(null);

  const consultant = config.sipUsername;

  const log = (step: string, data?: unknown) => {
    if (data !== undefined) {
      console.log(`[WebCalling] [${step}]`, data);
    } else {
      console.log(`[WebCalling] [${step}]`);
    }
  };

  const logError = (step: string, data?: unknown) => {
    if (data !== undefined) {
      console.error(`[WebCalling] [${step}] ❌`, data);
    } else {
      console.error(`[WebCalling] [${step}] ❌`);
    }
  };

  const testMicrophone = async (): Promise<{ ok: boolean; label?: string; error?: string }> => {
    log('MIC.test.start');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      logError('MIC.test.unsupported', 'navigator.mediaDevices.getUserMedia not available');
      return { ok: false, error: 'getUserMedia not supported' };
    }
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter((d) => d.kind === 'audioinput');
      log('MIC.test.devices', {
        total: devices.length,
        audioInputs: audioInputs.length,
        labels: audioInputs.map((d) => d.label || '(label hidden until permission granted)'),
      });
      if (audioInputs.length === 0) {
        logError('MIC.test.no-devices', 'No audio input devices enumerated');
        return { ok: false, error: 'No audio input device found' };
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const track = stream.getAudioTracks()[0];
      const label = track?.label ?? 'unknown';
      log('MIC.test.success', { label, settings: track?.getSettings() });
      stream.getTracks().forEach((t) => t.stop());
      return { ok: true, label };
    } catch (err) {
      const e = err as DOMException;
      logError('MIC.test.failed', { name: e.name, message: e.message });
      return { ok: false, error: `${e.name}: ${e.message}` };
    }
  };

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
    const url = `${config.apiBaseUrl}/v1/asterisk/events`;
    log('API.event.send', { url, eventType, payload });
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType, ...payload }),
      });
      log('API.event.response', {
        url,
        status: res.status,
        ok: res.ok,
        statusText: res.statusText,
      });
    } catch (err) {
      logError('API.event.error', {
        url,
        eventType,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // --- Outbound call session tracking ---

  const attachSessionEvents = (
    session: Session,
    callId: string,
    phoneNumber: string,
  ) => {
    session.stateChange.addListener((state) => {
      log('SIP.session.state', {
        callId,
        phoneNumber,
        outgoingNumber,
        state: SessionState[state],
      });
      if (state === SessionState.Establishing) {
        setStatus('Ringing...');
      }
      if (state === SessionState.Established) {
        setStatus('Call active');
        log('SIP.session.established', { callId });
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
        log('SIP.session.terminated', { callId });
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
      log('BOOT.config', {
        apiBaseUrl: config.apiBaseUrl,
        sipWebsocket: config.sipWebsocket,
        sipDomain: config.sipDomain,
        sipUsername: config.sipUsername,
        turnUrl: config.turnUrl,
      });

      const uri = UserAgent.makeURI(
        `sip:${consultant}@${config.sipDomain}`,
      );
      if (!uri) {
        logError('BOOT.uri.invalid', {
          consultant,
          sipDomain: config.sipDomain,
        });
        setStatus('Invalid SIP configuration');
        return;
      }
      log('BOOT.uri.built', { uri: uri.toString() });

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
            onConnect: () => {
              log('SIP.ws.connected', { server: config.sipWebsocket });
              setStatus('Socket connected');
            },
            onDisconnect: (error) => {
              logError('SIP.ws.disconnected', {
                server: config.sipWebsocket,
                error:
                  error instanceof Error ? error.message : String(error ?? ''),
              });
              setIsRegistered(false);
              setStatus('Socket disconnected');
            },
            onInvite: handleIncomingCall,
          },
        });
        log('SIP.userAgent.created');

        const reg = new Registerer(ua);
        reg.stateChange.addListener((state) => {
          log('SIP.registerer.state', { state: RegistererState[state] });
          if (state === RegistererState.Registered) {
            setIsRegistered(true);
            setStatus('Socket connected, registered');
          }
          if (state === RegistererState.Unregistered) {
            setIsRegistered(false);
            setStatus('Socket connected, registration failed');
          }
        });
        log('SIP.userAgent.starting');
        await ua.start();
        log('SIP.userAgent.started');
        setStatus('Socket connected, registering...');
        await reg.register();
        log('SIP.register.success', { consultant });

        userAgentRef.current = ua;
        registererRef.current = reg;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Connection failed';
        logError('SIP.register.failed', {
          consultant,
          sipWebsocket: config.sipWebsocket,
          message: msg,
        });
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

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (!outgoingMenuRef.current) return;
      if (!outgoingMenuRef.current.contains(event.target as Node)) {
        setIsOutgoingMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    log('BOOT.mic.preflight');
    void testMicrophone().then((result) => {
      setMicStatus(result.ok ? 'ok' : 'fail');
      if (result.ok && result.label) setMicDeviceLabel(result.label);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Incoming call handler ---

  function handleIncomingCall(invitation: Invitation) {
    inboundInviteRef.current = invitation;
    const caller = invitation.remoteIdentity.uri.user ?? 'unknown';
    log('INBOUND.invite.received', { caller, consultant });
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
      log('INBOUND.session.state', {
        callId,
        caller,
        state: SessionState[state],
      });
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
    log('DIAL.click', { dialNumber, outgoingNumber, isRegistered });

    if (!isRegistered) {
      logError('DIAL.not-registered', 'SIP not registered yet');
      setStatus('Not registered');
      return;
    }
    if (!userAgentRef.current) {
      logError('DIAL.no-user-agent', 'UserAgent missing');
      return;
    }
    if (!dialNumber.trim()) {
      logError('DIAL.empty-number');
      return;
    }

    log('DIAL.preflight.mic.start');
    const mic = await testMicrophone();
    if (!mic.ok) {
      logError('DIAL.preflight.mic.failed', mic.error);
      setStatus(`Microphone error: ${mic.error}`);
      setMicStatus('fail');
      return;
    }
    setMicStatus('ok');
    setMicDeviceLabel(mic.label ?? '');
    log('DIAL.preflight.mic.passed', { device: mic.label });

    const target = UserAgent.makeURI(
      `sip:${dialNumber}@${config.sipDomain}`,
    );
    if (!target) {
      logError('DIAL.uri.invalid', {
        dialNumber,
        sipDomain: config.sipDomain,
      });
      setStatus('Invalid phone number');
      return;
    }
    log('DIAL.uri.built', { target: target.toString() });

    const callId = crypto.randomUUID();
    setActiveCallId(callId);
    log('DIAL.callId.assigned', { callId });

    const inviter = new Inviter(userAgentRef.current, target as URI);
    log('DIAL.inviter.created', { callId, dialNumber, outgoingNumber });
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

    log('DIAL.invite.sending', {
      callId,
      target: target.toString(),
      headers: { 'X-Outgoing-Number': outgoingNumber },
    });
    try {
      await inviter.invite({
        requestOptions: {
          extraHeaders: [`X-Outgoing-Number: ${outgoingNumber}`],
        },
      });
      log('DIAL.invite.sent', { callId });
    } catch (err) {
      const e = err as Error;
      logError('DIAL.invite.failed', {
        callId,
        name: e.name,
        message: e.message,
      });
      setStatus(`Call failed: ${e.message}`);
    }
  };

  const answer = async () => {
    if (!inboundInviteRef.current) return;
    log('INBOUND.answer.click');
    await inboundInviteRef.current.accept();
    log('INBOUND.answer.accepted');
  };

  const reject = async () => {
    if (!inboundInviteRef.current) return;
    log('INBOUND.reject.click');
    await inboundInviteRef.current.reject();
    setStatus('Ready');
  };

  const hangup = async () => {
    const session = activeSessionRef.current ?? inboundInviteRef.current;
    if (!session) return;

    if (session.state === SessionState.Established) {
      log('HANGUP.bye.established');
      await session.bye();
    } else if (session instanceof Inviter) {
      log('HANGUP.cancel.outbound');
      await session.cancel();
    } else if (session instanceof Invitation) {
      log('HANGUP.reject.inbound');
      await session.reject();
    }
  };

  const toggleDnd = async () => {
    const next = !dndEnabled;
    log('DND.toggle.click', { consultant, enabled: next });
    setDndEnabled(next);
    const url = `${config.apiBaseUrl}/v1/dnd/${consultant}`;
    try {
      const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      log('DND.api.response', { url, status: res.status, ok: res.ok });
    } catch (err) {
      logError('DND.api.error', {
        url,
        consultant,
        enabled: next,
        message: err instanceof Error ? err.message : String(err),
      });
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

      <div className="mic-bar">
        <span className={`mic-dot mic-${micStatus}`} />
        <span className="mic-text">
          Microphone:{' '}
          {micStatus === 'ok'
            ? `OK (${micDeviceLabel || 'detected'})`
            : micStatus === 'fail'
              ? 'Not available'
              : 'Checking...'}
        </span>
        <button
          type="button"
          className="btn-test-mic"
          onClick={async () => {
            const r = await testMicrophone();
            setMicStatus(r.ok ? 'ok' : 'fail');
            setMicDeviceLabel(r.ok ? r.label ?? '' : r.error ?? '');
          }}
        >
          Test Mic
        </button>
      </div>

      <section className="card">
        <h2>Make a Call</h2>

        <label>
          Call from
          <div className="dropdown" ref={outgoingMenuRef}>
            <button
              type="button"
              className="dropdown-trigger"
              onClick={() => setIsOutgoingMenuOpen((open) => !open)}
              disabled={isOnCall}
            >
              <span>{formatAuNumber(outgoingNumber)}</span>
              <span className="dropdown-caret">▾</span>
            </button>
            {isOutgoingMenuOpen && (
              <ul className="dropdown-menu">
                {OUTGOING_NUMBERS.map((num) => (
                  <li key={num}>
                    <button
                      type="button"
                      className={`dropdown-item ${num === outgoingNumber ? 'selected' : ''}`}
                      onClick={() => {
                        setOutgoingNumber(num);
                        setIsOutgoingMenuOpen(false);
                      }}
                    >
                      {formatAuNumber(num)}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
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

      {/* <section className="card card-dnd">
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
      </section> */}

      <audio ref={remoteAudioRef} autoPlay />
    </main>
  );
}

export default App;
