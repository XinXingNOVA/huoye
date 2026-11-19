import type { ReactNode } from 'react'

/** 随包交付，入口与面板内控件共用线条图标；尺寸由所在画面决定。 */
function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
}
export const MusicIcon = () => <Icon><path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2.5"/><ellipse cx="17" cy="16" rx="3" ry="2.5"/></Icon>
export const LyricsIcon = () => <Icon><path d="M8 5h8M4 10h16M6 15h12M8 20h8"/></Icon>
export const QueueIcon = () => <Icon><path d="M3 5h12M3 10h12M3 15h6M17 18V9l4-1"/><ellipse cx="14" cy="18" rx="3" ry="2.5"/></Icon>
export const PreviousIcon = () => <Icon><path d="M5 5v14M19 5 8 12l11 7Z"/></Icon>
export const NextIcon = () => <Icon><path d="M19 5v14M5 5l11 7-11 7Z"/></Icon>
export const PlayIcon = () => <Icon><path d="m8 5 11 7-11 7Z" fill="currentColor" stroke="none"/></Icon>
export const PauseIcon = () => <Icon><path d="M8 5v14M16 5v14" strokeWidth="3"/></Icon>
export const VolumeIcon = () => <Icon><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/></Icon>
