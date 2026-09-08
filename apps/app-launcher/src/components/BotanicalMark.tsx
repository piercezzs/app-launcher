interface BotanicalMarkProps {
  readonly className?: string;
}

export function BotanicalMark({ className }: BotanicalMarkProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 72 104"
      role="img"
      aria-label="叶片标记"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path className="botanical-mark__stem" d="M14 96C24 73 31 51 45 13" />
      <path className="botanical-mark__leaf" d="M44 14C55 11 64 12 66 15C64 27 57 36 44 40C39 31 39 22 44 14Z" />
      <path className="botanical-mark__leaf botanical-mark__leaf--soft" d="M31 45C43 39 54 40 58 44C54 56 46 63 33 64C27 57 27 51 31 45Z" />
      <path className="botanical-mark__leaf" d="M24 61C15 55 7 55 4 58C5 69 11 76 21 79C26 73 27 67 24 61Z" />
      <path className="botanical-mark__leaf botanical-mark__leaf--soft" d="M38 32C31 25 23 22 19 25C18 35 22 43 30 48C37 44 39 38 38 32Z" />
      <path className="botanical-mark__vein" d="M45 39L60 18M33 63L51 46M21 78L9 61M31 47L22 28" />
    </svg>
  );
}
