'use client';

import { useState, useEffect, useRef } from 'react';
import { apiFetch, getWebSocketUrl } from '@/app/lib/api';

interface Participant {
  user_id: string;
  joined_at: string;
}

// WebRTC ICE configuration.
// - STUN lets peers discover their public address (enough for same-network or
//   friendly-NAT peers).
// - TURN relays the audio when direct peer-to-peer fails — the common case for
//   testers on different networks behind NAT. Multiple ports/transports are
//   listed so a working path can be found through restrictive firewalls
//   (UDP/80, TCP/80, UDP/443, TLS/443).
// Credentials are a Metered.ca free-tier relay. TURN credentials are always
// exposed to the browser by design, so they are not a secret.
const TURN_USERNAME = 'a43be5ae60dfc22da44ac94d';
const TURN_CREDENTIAL = 'AtYVhC5fn7xdhvNL';

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turn:global.relay.metered.ca:443', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
  { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
];

export default function VoiceChannelView({
  channelId,
  channelName,
}: {
  channelId: string;
  channelName: string;
}) {
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState<string | null>(null);

  const joinedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  // ICE candidates that arrive before the peer's remote description is set
  // are buffered here and flushed once the description is applied.
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>());
  const audioContainerRef = useRef<HTMLDivElement>(null);

  function addAudio(userId: string, stream: MediaStream) {
    const container = audioContainerRef.current;
    if (!container) return;
    let el = container.querySelector<HTMLAudioElement>(`audio[data-uid="${userId}"]`);
    if (!el) {
      el = document.createElement('audio');
      el.dataset.uid = userId;
      el.autoplay = true;
      container.appendChild(el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    // Explicit play() in case autoplay is gated; the user clicked "Join", so a
    // gesture exists and this should succeed.
    el.play().catch(() => {});
  }

  function removePeer(userId: string) {
    peersRef.current.get(userId)?.close();
    peersRef.current.delete(userId);
    pendingCandidatesRef.current.delete(userId);
    audioContainerRef.current?.querySelector(`audio[data-uid="${userId}"]`)?.remove();
  }

  // Apply any ICE candidates that were buffered before the remote description.
  async function flushCandidates(userId: string, pc: RTCPeerConnection) {
    const buf = pendingCandidatesRef.current.get(userId);
    if (!buf) return;
    pendingCandidatesRef.current.delete(userId);
    for (const c of buf) {
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* ignore individual bad candidate */
      }
    }
  }

  function makePeer(userId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peersRef.current.set(userId, pc);

    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));

    const remote = new MediaStream();
    pc.ontrack = (e) => {
      remote.addTrack(e.track);
      addAudio(userId, remote);
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'ice-candidate',
          target_user_id: userId,
          candidate: e.candidate.toJSON(),
        }));
      }
    };
    pc.oniceconnectionstatechange = () => {
      console.log(`[voice] peer ${userId} ICE: ${pc.iceConnectionState}`);
    };
    return pc;
  }

  // Adds a remote ICE candidate, buffering it if the peer is not ready yet.
  async function addRemoteCandidate(userId: string, cand: RTCIceCandidateInit) {
    const pc = peersRef.current.get(userId);
    if (pc && pc.remoteDescription) {
      try {
        await pc.addIceCandidate(cand);
      } catch {
        /* ignore */
      }
      return;
    }
    const buf = pendingCandidatesRef.current.get(userId) ?? [];
    buf.push(cand);
    pendingCandidatesRef.current.set(userId, buf);
  }

  async function handleMessage(raw: string) {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const type = data.type as string;

    // Presence events come from the voice service and carry `user_id`.
    if (type === 'participant_joined') {
      const uid = data.user_id as string | undefined;
      if (uid) {
        setParticipants((p) =>
          p.some((x) => x.user_id === uid)
            ? p
            : [...p, { user_id: uid, joined_at: new Date().toISOString() }],
        );
      }
      // The newcomer initiates the offer to us — nothing to do here.
      return;
    }

    if (type === 'participant_left') {
      const uid = data.user_id as string | undefined;
      if (uid) {
        setParticipants((p) => p.filter((x) => x.user_id !== uid));
        removePeer(uid);
      }
      return;
    }

    // Relayed signaling messages are stamped by the server with `sender_user_id`.
    const from = data.sender_user_id as string | undefined;
    if (!from) return;

    if (type === 'offer') {
      const pc = peersRef.current.get(from) ?? makePeer(from);
      await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp as string });
      await flushCandidates(from, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsRef.current?.send(JSON.stringify({ type: 'answer', target_user_id: from, sdp: answer.sdp }));
      return;
    }

    if (type === 'answer') {
      const pc = peersRef.current.get(from);
      if (pc) {
        await pc.setRemoteDescription({ type: 'answer', sdp: data.sdp as string });
        await flushCandidates(from, pc);
      }
      return;
    }

    if (type === 'ice-candidate') {
      await addRemoteCandidate(from, data.candidate as RTCIceCandidateInit);
    }
  }

  function doCleanup(callLeaveApi: boolean) {
    if (callLeaveApi) {
      apiFetch(`/voice/${channelId}/leave`, { method: 'POST' }).catch(() => {});
    }
    wsRef.current?.close();
    wsRef.current = null;
    peersRef.current.forEach((pc) => pc.close());
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (audioContainerRef.current) audioContainerRef.current.innerHTML = '';
    joinedRef.current = false;
  }

  async function handleJoin() {
    setJoining(true);
    setError(null);
    try {
      const joinRes = await apiFetch(`/voice/${channelId}/join`, { method: 'POST' });
      if (joinRes.status === 403) {
        setError('You do not have permission to join this voice channel');
        return;
      }
      if (!joinRes.ok) throw new Error('join failed');
      const joinData = (await joinRes.json()) as { user_id: string };
      const myUserId = joinData.user_id;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        setError('Microphone access denied');
        return;
      }
      localStreamRef.current = stream;

      // Snapshot who is already in the channel — the newcomer offers to them.
      let existingUserIds: string[] = [];
      const partRes = await apiFetch(`/voice/${channelId}/participants`);
      if (partRes.ok) {
        const d = (await partRes.json()) as { participants: Participant[] };
        setParticipants(d.participants);
        existingUserIds = d.participants
          .map((p) => p.user_id)
          .filter((u) => u !== myUserId);
      }

      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('not authenticated');

      const ws = new WebSocket(getWebSocketUrl(`/voice/${channelId}/signal`));
      wsRef.current = ws;

      ws.onopen = () => {
        // Newcomer initiates: send an offer to everyone already in the channel.
        // Done here (not on participant_joined) so both peers' sockets exist.
        for (const uid of existingUserIds) {
          const pc = makePeer(uid);
          pc.createOffer()
            .then(async (offer) => {
              await pc.setLocalDescription(offer);
              wsRef.current?.send(
                JSON.stringify({ type: 'offer', target_user_id: uid, sdp: offer.sdp }),
              );
            })
            .catch(() => {});
        }
      };
      ws.onmessage = (ev) => {
        handleMessage(ev.data as string).catch(() => {});
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (joinedRef.current) {
          doCleanup(false);
          setJoined(false);
          setParticipants([]);
        }
      };

      joinedRef.current = true;
      setJoined(true);
    } catch {
      setError('Failed to join voice channel');
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    } finally {
      setJoining(false);
    }
  }

  function handleLeave() {
    setLeaving(true);
    doCleanup(true);
    setJoined(false);
    setParticipants([]);
    setLeaving(false);
  }

  useEffect(() => {
    return () => {
      if (joinedRef.current) doCleanup(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-[#1a1a1d] shrink-0">
        <span className="text-zinc-500 text-sm">🔊</span>
        <span className="font-semibold text-zinc-100 text-sm">{channelName}</span>
      </div>

      {/* Hidden container for remote audio elements */}
      <div ref={audioContainerRef} className="hidden" aria-hidden="true" />

      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        {!joined ? (
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="w-20 h-20 rounded-full bg-[#27272a] flex items-center justify-center text-4xl">
              🔊
            </div>
            <div>
              <h2 className="text-xl font-bold text-zinc-100">{channelName}</h2>
              <p className="text-sm text-zinc-500 mt-1">Voice Channel</p>
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button
              onClick={handleJoin}
              disabled={joining}
              className="px-8 py-3 bg-green-600 hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors cursor-pointer"
            >
              {joining ? 'Joining…' : 'Join Voice'}
            </button>
          </div>
        ) : (
          <div className="w-full max-w-sm flex flex-col items-center gap-6">
            <div className="w-full bg-[#111113] border border-[#1a1a1d] rounded-xl p-4">
              <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-600 mb-3">
                Participants — {participants.length}
              </h3>
              {participants.length === 0 ? (
                <p className="text-xs text-zinc-700 italic">No other participants</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {participants.map((p) => (
                    <div key={p.user_id} className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-indigo-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                        {p.user_id.slice(0, 1).toUpperCase()}
                      </div>
                      <span className="text-sm text-zinc-300 truncate">{p.user_id}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 px-4 py-2 bg-green-900/30 border border-green-800/50 rounded-lg">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-sm text-green-400 font-medium">Connected</span>
            </div>

            <button
              onClick={handleLeave}
              disabled={leaving}
              className="px-8 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-colors cursor-pointer"
            >
              {leaving ? 'Leaving…' : 'Leave Voice'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
