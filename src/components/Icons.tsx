// Inline SVG icons (no emoji: emoji fonts are missing on many Linux installs).

type P = { size?: number; className?: string };

const svg = (paths: React.ReactNode) =>
  function Icon({ size = 15, className }: P) {
    return (
      <svg className={`ico ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {paths}
      </svg>
    );
  };

export const IFolder = svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" fillOpacity=".18" />);
export const IFolderOut = svg(
  <>
    <path d="M10 19H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3" />
    <path d="M15 17h6M18 14l3 3-3 3" />
  </>,
);
export const IFile = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </>,
);
export const IFileCode = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M10 12l-2 2 2 2M14 12l2 2-2 2" />
  </>,
);
export const IArchive = svg(
  <>
    <rect x="3" y="4" width="18" height="5" rx="1" />
    <path d="M5 9v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4" />
  </>,
);
export const IImage = svg(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="M21 15l-5-5L5 21" />
  </>,
);
export const ITrash = svg(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />);
export const IEdit = svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />);
export const IPlus = svg(<path d="M12 5v14M5 12h14" />);
export const IFolderPlus = svg(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6" />);
export const IRefresh = svg(<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />);
export const IUp = svg(<path d="M12 19V5M5 12l7-7 7 7" />);
export const IEye = svg(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const IClose = svg(<path d="M18 6L6 18M6 6l12 12" />);
export const IMonitor = svg(
  <>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </>,
);
export const IServer = svg(
  <>
    <rect x="3" y="3" width="18" height="8" rx="2" />
    <rect x="3" y="13" width="18" height="8" rx="2" />
    <path d="M7 7h.01M7 17h.01" />
  </>,
);
export const IKey = svg(<path d="M15 7a4 4 0 1 1-3.9 4.9L3 20v-3h3v-3h3l2.1-2.1A4 4 0 0 1 15 7zM16 8h.01" />);
export const ILock = svg(
  <>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 0 1 8 0v4" />
  </>,
);
export const ICopy = svg(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </>,
);
export const ITransfer = svg(<path d="M7 4v16M3 8l4-4 4 4M17 20V4M21 16l-4 4-4-4" />);
export const IUpload = svg(<path d="M12 16V4M7 9l5-5 5 5M4 20h16" />);
export const IDownload = svg(<path d="M12 4v12M7 11l5 5 5-5M4 20h16" />);
export const ITerminal = svg(<path d="M4 17l6-5-6-5M12 19h8" />);
export const IPlay = svg(<path d="M7 4l13 8-13 8z" fill="currentColor" fillOpacity=".2" />);
export const IScript = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M9 13l2 2-2 2M13 17h3" />
  </>,
);
export const IFilePlus = svg(
  <>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5M12 11v6M9 14h6" />
  </>,
);
export const ISplitRight = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </>,
);
export const ISplitDown = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </>,
);
export const ISidebar = svg(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M9 4v16" />
  </>,
);
export const IActivity = svg(<path d="M3 12h4l3-8 4 16 3-8h4" />);
export const IChevronDown = svg(<path d="M6 9l6 6 6-6" />);
export const IHome = svg(<path d="M3 11l9-7 9 7M5 9v11h14V9" />);
export const ILink = svg(<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />);
export const ISave = svg(<path d="M5 3h11l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM7 3v6h8V3M7 21v-7h10v7" />);
// Window controls: thin strokes, drawn on a 10x10 grid like native captions.
const cap = (d: string) =>
  function Caption() {
    return (
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth={1} aria-hidden>
        <path d={d} />
      </svg>
    );
  };
export const ICapMin = cap("M0 5.5h10");
export const ICapMax = cap("M.5.5h9v9h-9z");
export const ICapRestore = cap("M.5 2.5h7v7h-7zM2.5 2.5V.5h7v7h-2");
export const ICapClose = cap("M0 0l10 10M10 0L0 10");
