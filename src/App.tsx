import { useMemo, useRef, useState } from 'react';
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

const defaultConfig = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000',
  sipWebsocket: import.meta.env.VITE_SIP_WSS_URL ?? 'wss://pbx.example.com:8089/ws',
  sipDomain: import.meta.env.VITE_SIP_DOMAIN ?? 'pbx.example.com',
  sipUsername: import.meta.env.VITE_SIP_USERNAME ?? 'venus',
  sipPassword: import.meta.env.VITE_SIP_PASSWORD ?? 'change_me',
  turnUrl: import.meta.env.VITE_TURN_URL ?? 'turn:pbx.example.com:3478?transport=udp',
  turnUsername: import.meta.env.VITE_TURN_USERNAME ?? 'webrtc-user',
  turnPassword: import.meta.env.VITE_TURN_PASSWORD ?? 'webrtc-password',
};

function App() {
  const [consultant, setConsultant] = useState(defaultConfig.sipUsername);
  const [dialNumber, setDialNumber] = useState('');
  const [incomingNumber, setIncomingNumber] = useState('');
  const [status, setStatus] = useState('Idle');
  const [isRegistered, setIsRegistered] = useState(false);
  const [dndEnabled, setDndEnabled] = useState(false);
  const [activeCallId, setActiveCallId] = useState<string>();

  const userAgentRef = useRef<UserAgent | undefined>(undefined);
  const registererRef = useRef<Registerer | undefined>(undefined);
  const activeSessionRef = useRef<Session | undefined>(undefined);
  const inboundInviteRef = useRef<Invitation | undefined>(undefined);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  const consultantUri = useMemo(
    () => UserAgent.makeURI(`sip:${consultant}@${defaultConfig.sipDomain}`),
    [consultant],
  );

  const bindMedia = (session: Session) => {
    const handler = session.sessionDescriptionHandler as {
      peerConnection?: RTCPeerConnection;
    };
    const peerConnection = handler?.peerConnection;
    const remoteAudio = remoteAudioRef.current;
    if (!peerConnection || !remoteAudio) {
      return;
    }
    const remoteStream = new MediaStream();
    peerConnection.getReceivers().forEach((receiver) => {
      if (receiver.track) {
        remoteStream.addTrack(receiver.track);
      }
    });
    remoteAudio.srcObject = remoteStream;
    remoteAudio.play().catch(() => null);
  };

  const pushBackendEvent = async (
    eventType: 'inbound' | 'oncall' | 'disconnected' | 'DNDon' | 'DNDoff',
    payload: Record<string, unknown>,
  ) => {
    await fetch(`${defaultConfig.apiBaseUrl}/v1/asterisk/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType, ...payload }),
    });
  };

  const attachSessionEvents = (session: Session, callId: string, phoneNumber: string) => {
    session.stateChange.addListener((nextState) => {
      if (nextState === SessionState.Establishing) {
        setStatus('Call connecting...');
      }
      if (nextState === SessionState.Established) {
        setStatus('Call active');
        void pushBackendEvent('oncall', {
          callId,
          consultant,
          phoneNumber,
          direction: 'outbound',
          status: 'answered',
        });
        bindMedia(session);
      }
      if (nextState === SessionState.Terminated) {
        setStatus('Call ended');
        void pushBackendEvent('disconnected', {
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

  const registerConsultant = async () => {
    if (!consultantUri) {
      setStatus('Invalid consultant URI');
      return;
    }
    try {
      const userAgent = new UserAgent({
        uri: consultantUri,
        authorizationUsername: consultant,
        authorizationPassword: defaultConfig.sipPassword,
        transportOptions: { server: defaultConfig.sipWebsocket },
        sessionDescriptionHandlerFactoryOptions: {
          peerConnectionConfiguration: {
            iceServers: [
              {
                urls: [defaultConfig.turnUrl],
                username: defaultConfig.turnUsername,
                credential: defaultConfig.turnPassword,
              },
            ],
          },
        },
        delegate: {
          onInvite: (invitation) => {
            inboundInviteRef.current = invitation;
            const caller = invitation.remoteIdentity.uri.user ?? 'unknown';
            setIncomingNumber(caller);
            setStatus(`Incoming call from ${caller}`);
            const callId = crypto.randomUUID();
            setActiveCallId(callId);
            void pushBackendEvent('inbound', {
              callId,
              consultant,
              phoneNumber: caller,
              direction: 'inbound',
              status: 'ringing',
            });
            invitation.stateChange.addListener((nextState) => {
              if (nextState === SessionState.Established) {
                setStatus('Incoming call active');
                bindMedia(invitation);
              }
              if (nextState === SessionState.Terminated) {
                setStatus('Incoming call ended');
                void pushBackendEvent('disconnected', {
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
          },
        },
      });

      const registerer = new Registerer(userAgent);
      await userAgent.start();
      await registerer.register();
      userAgentRef.current = userAgent;
      registererRef.current = registerer;
      setStatus('Registered and ready');
      setIsRegistered(true);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown registration error';
      setStatus(`Register failed: ${message}`);
      setIsRegistered(false);
    }
  };

  const unregisterConsultant = async () => {
    const registerer = registererRef.current;
    const userAgent = userAgentRef.current;
    if (registerer) {
      await registerer.unregister();
    }
    if (userAgent) {
      await userAgent.stop();
    }
    setIsRegistered(false);
    setStatus('Unregistered');
  };

  const dial = async () => {
    if (!isRegistered || !userAgentRef.current || !dialNumber) {
      return;
    }
    const target = UserAgent.makeURI(`sip:${dialNumber}@${defaultConfig.sipDomain}`);
    if (!target) {
      setStatus('Invalid target number');
      return;
    }
    const callId = crypto.randomUUID();
    setActiveCallId(callId);
    const inviter = new Inviter(userAgentRef.current, target as URI);
    activeSessionRef.current = inviter;
    attachSessionEvents(inviter, callId, dialNumber);
    setStatus(`Dialing ${dialNumber}`);
    await pushBackendEvent('oncall', {
      callId,
      consultant,
      phoneNumber: dialNumber,
      direction: 'outbound',
      status: 'ringing',
    });
    await inviter.invite();
  };

  const answer = async () => {
    if (!inboundInviteRef.current) {
      return;
    }
    await inboundInviteRef.current.accept();
  };

  const reject = async () => {
    if (!inboundInviteRef.current) {
      return;
    }
    await inboundInviteRef.current.reject();
    setStatus('Incoming call rejected');
  };

  const hangup = async () => {
    const session = activeSessionRef.current ?? inboundInviteRef.current;
    if (!session) {
      return;
    }
    if (session.state === SessionState.Established) {
      await session.bye();
      return;
    }
    if (session instanceof Inviter) {
      await session.cancel();
      return;
    }
    if (session instanceof Invitation) {
      await session.reject();
    }
  };

  const toggleDnd = async () => {
    const nextValue = !dndEnabled;
    setDndEnabled(nextValue);
    await fetch(`${defaultConfig.apiBaseUrl}/v1/dnd/${consultant}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: nextValue }),
    });
    await pushBackendEvent(nextValue ? 'DNDon' : 'DNDoff', { consultant });
    setStatus(nextValue ? 'DND enabled' : 'DND disabled');
  };

  return (
    <main className="app">
      <h1>Web Calling Console</h1>
      <p className="status">Status: {status}</p>

      <section className="card">
        <h2>Consultant</h2>
        <label>
          Username
          <input value={consultant} onChange={(event) => setConsultant(event.target.value)} />
        </label>
        <div className="actions">
          <button onClick={registerConsultant} disabled={isRegistered}>
            Register
          </button>
          <button onClick={unregisterConsultant} disabled={!isRegistered}>
            Unregister
          </button>
          <button onClick={toggleDnd} disabled={!isRegistered}>
            {dndEnabled ? 'Disable DND' : 'Enable DND'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Outgoing</h2>
        <label>
          Number
          <input value={dialNumber} onChange={(event) => setDialNumber(event.target.value)} />
        </label>
        <div className="actions">
          <button onClick={dial} disabled={!isRegistered}>
            Dial
          </button>
          <button onClick={hangup} disabled={!activeCallId}>
            Hangup
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Incoming</h2>
        <p>Caller: {incomingNumber || 'No incoming call'}</p>
        <div className="actions">
          <button onClick={answer} disabled={!incomingNumber}>
            Accept
          </button>
          <button onClick={reject} disabled={!incomingNumber}>
            Reject
          </button>
        </div>
      </section>

      <audio ref={remoteAudioRef} autoPlay />
    </main>
  );
}

export default App;
