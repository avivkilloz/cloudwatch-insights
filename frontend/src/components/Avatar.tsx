interface Props {
  username: string;
  avatarUrl?: string | null;
  size?: number;
}

// Deterministic per-username color so the same person always gets the same
// initials-avatar background, without needing to store a color anywhere.
function colorForUsername(username: string): string {
  let hash = 0;
  for (let i = 0; i < username.length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash) % 360}, 55%, 42%)`;
}

export default function Avatar({ username, avatarUrl, size = 32 }: Props) {
  if (avatarUrl) {
    return (
      <img
        className="avatar"
        src={avatarUrl}
        alt=""
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="avatar avatar-initials"
      style={{ width: size, height: size, fontSize: size * 0.42, background: colorForUsername(username) }}
    >
      {username.trim().charAt(0).toUpperCase() || "?"}
    </div>
  );
}
