import reactorLogo from "./reactor-logo-white.png";

/** Reactor's page for the model that films every clip. */
const omniPage = "https://www.reactor.inc/models/fast-h3-omni";

/**
 * The Powered by Reactor badge: Reactor's own core logo (from its brand kit, unaltered) in the
 * bottom right corner of every screen, linking to the FastH3-Omni model page. Only the badge
 * itself takes the pointer, so it never swallows a click meant for what is around it.
 */
export function PoweredBy() {
  return (
    <a
      className="powered-by"
      href={omniPage}
      target="_blank"
      rel="noopener"
      title="FastH3-Omni by Reactor"
      data-testid="powered-by"
    >
      <span className="powered-by-label">Powered by</span>
      <img className="powered-by-logo" src={reactorLogo} alt="Reactor" width={104} height={12} />
    </a>
  );
}
