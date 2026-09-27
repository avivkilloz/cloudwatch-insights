/** The mark beside a session the platform agent is changing right now: in
 * the panel and on the strip, so you can see where it's working from
 * wherever you are. */
export default function AgentWorking() {
  return (
    <span className="agent-working" title="The agent is working on this session" aria-label="The agent is working on this">
      ✦
    </span>
  );
}
