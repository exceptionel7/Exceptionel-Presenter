/**
 * The Exceptionel mark: a squared "C" in metallic silver with the cyan→blue play triangle
 * nested in its aperture. Inline SVG rather than an <img> so it inherits sizing, stays
 * crisp at any scale, and needs no asset request.
 */

export function LogoMark({ size = 24, className = '' }: { size?: number; className?: string }): JSX.Element {
  // Gradient ids must be unique per instance, or two marks on one page share the first
  // definition and the second renders unpainted.
  const uid = `ep-${size}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      className={className}
      role="img"
      aria-label="Exceptionel Presenter"
    >
      <defs>
        <linearGradient id={`${uid}-silver`} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" />
          <stop offset="42%" stopColor="#E4EAF2" />
          <stop offset="62%" stopColor="#AFBECF" />
          <stop offset="100%" stopColor="#8496AC" />
        </linearGradient>
        <linearGradient id={`${uid}-signal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3FB0FA" />
          <stop offset="55%" stopColor="#1E8FEF" />
          <stop offset="100%" stopColor="#1F5FE8" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${uid}-silver)`}
        d="M330 54 H452 L392 130 H236
           a56 56 0 0 0 -56 56 V326
           a56 56 0 0 0 56 56 H392 L452 458 H330
           a150 150 0 0 1 -150 -150 V204
           A150 150 0 0 1 330 54 Z"
      />
      <path fill={`url(#${uid}-signal)`} d="M262 168 L404 256 L262 344 Z" />
    </svg>
  );
}

export function Wordmark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark size={22} />
      <div className="leading-none">
        <div className="text-[13px] font-bold tracking-[0.14em] text-silver-100">EXCEPTIONEL</div>
        <div className="text-[9px] font-medium tracking-[0.34em] text-silver-600 mt-0.5">PRESENTER</div>
      </div>
    </div>
  );
}
