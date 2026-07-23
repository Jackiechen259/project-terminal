import {
  Bot,
  Box,
  Cloud,
  Code2,
  Database,
  LayoutTemplate,
  Rocket,
  Server,
  Sparkles,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";

import type { ProfileTemplateIcon } from "@/types";

export interface ProfileTemplateIconOption {
  value: ProfileTemplateIcon;
  label: string;
  icon: LucideIcon;
}

export const PROFILE_TEMPLATE_ICON_OPTIONS: ProfileTemplateIconOption[] = [
  { value: "layout-template", label: "Template", icon: LayoutTemplate },
  { value: "terminal", label: "Terminal", icon: SquareTerminal },
  { value: "code", label: "Code", icon: Code2 },
  { value: "bot", label: "Bot", icon: Bot },
  { value: "sparkles", label: "Sparkles", icon: Sparkles },
  { value: "box", label: "Box", icon: Box },
  { value: "database", label: "Database", icon: Database },
  { value: "server", label: "Server", icon: Server },
  { value: "cloud", label: "Cloud", icon: Cloud },
  { value: "rocket", label: "Rocket", icon: Rocket },
];

const PROFILE_TEMPLATE_ICONS = Object.fromEntries(
  PROFILE_TEMPLATE_ICON_OPTIONS.map((option) => [option.value, option.icon]),
) as Record<ProfileTemplateIcon, LucideIcon>;

export function getProfileTemplateIcon(
  icon: ProfileTemplateIcon | undefined,
): LucideIcon {
  return icon ? PROFILE_TEMPLATE_ICONS[icon] : LayoutTemplate;
}
