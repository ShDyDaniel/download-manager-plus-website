import { Github } from 'lucide-react'
import { RELEASES_PAGE_URL } from '../api/releases'

export function Footer() {
  return (
    <footer className="border-t border-white/5 px-6 py-10">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-4 text-sm text-white/50 sm:flex-row">
        <div className="flex items-center gap-3">
          <img
            src="./icon.png"
            alt=""
            className="h-7 w-7 rounded-lg ring-1 ring-white/10"
          />
          <span>ניהול הורדות פלוס · © 2026</span>
        </div>
        <a
          href={RELEASES_PAGE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 transition-colors hover:text-white"
        >
          <Github className="h-4 w-4" />
          <span>GitHub Releases</span>
        </a>
      </div>
    </footer>
  )
}
