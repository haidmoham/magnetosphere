// Spotify Web Playback SDK wrapper.
//
// Responsibilities (Phase 5.1 — OAuth + playback foundation):
//   - Load the SDK script on demand
//   - Pull access tokens from Flask (/auth/spotify/token) with auto-refresh
//   - Initialise a Spotify.Player, expose ready / track-change / state hooks
//   - Transfer playback to this browser tab
//
// Beat sync (Phase 5.2) builds on top: track-change → fetch /v1/audio-analysis
// → schedule beats/sections/segments → drive visualizer uniforms.

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";

export class SpotifyEngine {
  constructor() {
    this.player          = null;
    this.deviceId        = null;
    this.currentTrack    = null;
    this.isReady         = false;
    this._token          = null;
    this._tokenExpiresAt = 0;

    // Public hooks — assigned by main.js.
    this.onReady       = null;  // (deviceId)        => void
    this.onTrackChange = null;  // (track)           => void
    this.onStateChange = null;  // (state)           => void  every state tick
    this.onError       = null;  // ({type, message}) => void
  }

  /** Pull token, load SDK, create + connect the Player. Throws on auth failure. */
  async init() {
    await this._refreshToken();
    await this._loadSDK();
    await this._sdkReady();

    this.player = new Spotify.Player({
      name: "Voidpulse",
      // Spotify SDK calls this when it needs a fresh token.
      getOAuthToken: cb => this._getFreshToken().then(cb).catch(() => cb("")),
      volume: 0.7,
    });

    // Ready / not-ready: device_id is what we transfer playback to.
    this.player.addListener("ready", ({ device_id }) => {
      this.deviceId = device_id;
      this.isReady  = true;
      this.onReady?.(device_id);
    });
    this.player.addListener("not_ready", () => { this.isReady = false; });

    // State change fires on every play/pause/seek/track-change. We use it
    // both for UI updates and (Phase 5.2) for kicking off analysis fetches.
    this.player.addListener("player_state_changed", state => {
      if (!state) return;
      const trackId = state.track_window?.current_track?.id;
      if (trackId && trackId !== this.currentTrack?.id) {
        this.currentTrack = state.track_window.current_track;
        this.onTrackChange?.(this.currentTrack);
      }
      this.onStateChange?.(state);
    });

    // Error categories Spotify exposes — surface them to main.js for the toast.
    for (const ev of ["initialization_error", "authentication_error",
                      "account_error",        "playback_error"]) {
      this.player.addListener(ev, ({ message }) => {
        this.onError?.({ type: ev, message });
      });
    }

    const ok = await this.player.connect();
    if (!ok) throw new Error("Failed to connect to Spotify Player");
  }

  /** Route Spotify playback to this browser tab. */
  async transferToThisDevice(autoplay = false) {
    if (!this.deviceId) throw new Error("Spotify device not ready yet");
    const token = await this._getFreshToken();
    const r = await fetch("https://api.spotify.com/v1/me/player", {
      method: "PUT",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ device_ids: [this.deviceId], play: autoplay }),
    });
    // 204 = success (no body). 202 = command accepted, will apply.
    if (!r.ok && r.status !== 204 && r.status !== 202) {
      throw new Error(`Spotify transfer failed: ${r.status} ${r.statusText}`);
    }
  }

  async togglePlay() { await this.player?.togglePlay(); }
  async pause()      { await this.player?.pause();      }
  async resume()     { await this.player?.resume();     }

  /** Volume 0–1. SDK clamps internally; we no-op if the player isn't ready. */
  async setVolume(v) {
    if (!this.player) return;
    try { await this.player.setVolume(Math.max(0, Math.min(1, v))); } catch {}
  }

  async disconnect() {
    try { await this.player?.disconnect(); } catch {}
    this.player       = null;
    this.deviceId     = null;
    this.currentTrack = null;
    this.isReady      = false;
  }

  // ── token helpers ─────────────────────────────────────────────────

  async _refreshToken() {
    const r = await fetch("/auth/spotify/token");
    if (!r.ok) throw new Error("Spotify not authenticated");
    const { access_token, expires_at } = await r.json();
    this._token          = access_token;
    this._tokenExpiresAt = expires_at;
  }

  async _getFreshToken() {
    if (Date.now() / 1000 < this._tokenExpiresAt - 60) return this._token;
    await this._refreshToken();
    return this._token;
  }

  // ── SDK loading ───────────────────────────────────────────────────

  _loadSDK() {
    if (window.Spotify) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src   = SDK_URL;
      s.async = true;
      s.onload  = resolve;
      s.onerror = () => reject(new Error("Failed to load Spotify SDK"));
      document.head.appendChild(s);
    });
  }

  _sdkReady() {
    if (window.Spotify?.Player) return Promise.resolve();
    return new Promise(resolve => {
      // The SDK calls this global hook once it's parsed and ready.
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
    });
  }
}
