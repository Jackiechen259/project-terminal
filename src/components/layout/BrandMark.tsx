import { useId } from "react";

/**
 * Compact in-app version of the application icon. The folder silhouette
 * represents a project workspace while the chevron and caret read as a
 * terminal prompt.
 */
export function BrandMark({ className = "" }: { className?: string }) {
  const gradientId = useId();

  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={gradientId}
          x1="4"
          y1="3"
          x2="20"
          y2="21"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#67E8F9" />
          <stop offset="0.52" stopColor="#60A5FA" />
          <stop offset="1" stopColor="#C4B5FD" />
        </linearGradient>
      </defs>
      <path
        d="M3.25 7.25A2.25 2.25 0 0 1 5.5 5h4.1l1.7 1.75h7.2A2.25 2.25 0 0 1 20.75 9v8.5a2.25 2.25 0 0 1-2.25 2.25h-13a2.25 2.25 0 0 1-2.25-2.25V7.25Z"
        fill="#090E22"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="m7.2 10 2.65 2.15L7.2 14.3M11.85 14.25h4.35"
        stroke={`url(#${gradientId})`}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
