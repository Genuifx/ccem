/**
 * Lucide-compatible icon surface backed by Hugeicons.
 * App code imports from `@/lib/lucide-react` with the old Lucide names/API.
 */
import {
  forwardRef,
  type ForwardRefExoticComponent,
  type RefAttributes,
  type SVGProps,
} from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  Activity01Icon,
  Alert02Icon,
  AlertCircleIcon,
  AppWindowIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  ArrowUpDoubleIcon,
  ArrowUpDownIcon,
  AttachmentIcon,
  BadgeAlertIcon,
  BarChartIcon,
  Book01Icon,
  BookOpen01Icon,
  BrainIcon,
  Bug01Icon,
  Building02Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckListIcon,
  CheckmarkCircle02Icon,
  CircleIcon,
  ClipboardCheckIcon,
  ClipboardIcon,
  Clock01Icon,
  Clock04Icon,
  CommandIcon,
  ComputerIcon,
  ComputerPhoneSyncIcon,
  Copy01Icon,
  DashboardSpeed01Icon,
  Delete02Icon,
  DiamondIcon,
  Dollar01Icon,
  Download01Icon,
  Edit02Icon,
  File01Icon,
  File02Icon,
  FileCodeIcon,
  FileEditIcon,
  FileImageIcon,
  FileScriptIcon,
  FileSpreadsheetIcon,
  Files01Icon,
  FireIcon,
  FloppyDiskIcon,
  Folder01Icon,
  FolderOpenIcon,
  FolderSearchIcon,
  FolderTreeIcon,
  GitCompareIcon,
  GitPullRequestIcon,
  Globe02Icon,
  GridViewIcon,
  HeartCheckIcon,
  HelpCircleIcon,
  Home01Icon,
  Idea01Icon,
  Image01Icon,
  InformationCircleIcon,
  Key01Icon,
  Layers01Icon,
  LayoutTwoColumnIcon,
  LeftToRightListBulletIcon,
  Link01Icon,
  Link02Icon,
  LinkSquare01Icon,
  LinkSquare02Icon,
  Loading03Icon,
  Maximize01Icon,
  Message01Icon,
  Message02Icon,
  MessageBlockedIcon,
  MessageMultiple01Icon,
  Minimize01Icon,
  MinusSignIcon,
  Moon02Icon,
  MoreHorizontalIcon,
  NewsIcon,
  Notification01Icon,
  Notification03Icon,
  PackageDeliveredIcon,
  PackageIcon,
  PaintBoardIcon,
  PauseIcon,
  PencilEdit01Icon,
  PencilEdit02Icon,
  PinIcon,
  PlayIcon,
  Plug01Icon,
  PlusSignIcon,
  PlusSignSquareIcon,
  QrCodeIcon,
  QuoteDownIcon,
  RadioIcon,
  RefreshIcon,
  Robot01Icon,
  Rocket01Icon,
  RotateLeft01Icon,
  RotateRight01Icon,
  ScissorIcon,
  ScrollIcon,
  Search01Icon,
  SecurityBlockIcon,
  SecurityCheckIcon,
  SecurityWarningIcon,
  SentIcon,
  ServerStack01Icon,
  Settings01Icon,
  Settings02Icon,
  Share01Icon,
  Shield01Icon,
  ShieldBanIcon,
  SidebarLeft01Icon,
  SidebarRight01Icon,
  SourceCodeCircleIcon,
  SourceCodeIcon,
  SparklesIcon,
  SquareIcon,
  SquareLock01Icon,
  StarIcon,
  Sun01Icon,
  Target01Icon,
  TerminalIcon,
  TestTube01Icon,
  Tick02Icon,
  Timer01Icon,
  TradeDownIcon,
  TradeUpIcon,
  UserGroupIcon,
  ViewIcon,
  WorkflowSquare01Icon,
  Wrench01Icon,
  ZapIcon,
} from '@hugeicons/core-free-icons';

export interface LucideProps extends Partial<SVGProps<SVGSVGElement>> {
  size?: string | number;
  absoluteStrokeWidth?: boolean;
  /** Accepted for Lucide compatibility; coerced to number when possible. */
  strokeWidth?: number | string;
}

export type LucideIcon = ForwardRefExoticComponent<
  Omit<LucideProps, 'ref'> & RefAttributes<SVGSVGElement>
>;

function createIcon(icon: IconSvgElement, displayName: string): LucideIcon {
  const Comp = forwardRef<SVGSVGElement, LucideProps>(function HugeIcon(
    {
      color = 'currentColor',
      size = 24,
      strokeWidth = 1.5,
      absoluteStrokeWidth,
      className,
      ...rest
    },
    ref,
  ) {
    const numericStroke =
      typeof strokeWidth === 'number'
        ? strokeWidth
        : Number.parseFloat(String(strokeWidth));

    return (
      <HugeiconsIcon
        ref={ref}
        icon={icon}
        color={color}
        size={size}
        strokeWidth={Number.isFinite(numericStroke) ? numericStroke : 1.5}
        absoluteStrokeWidth={absoluteStrokeWidth}
        className={className}
        {...rest}
      />
    );
  });
  Comp.displayName = displayName;
  return Comp;
}

export const Activity = createIcon(Activity01Icon, 'Activity');
export const AlertCircle = createIcon(AlertCircleIcon, 'AlertCircle');
export const AlertTriangle = createIcon(Alert02Icon, 'AlertTriangle');
export const AppWindow = createIcon(AppWindowIcon, 'AppWindow');
export const ArrowLeft = createIcon(ArrowLeft01Icon, 'ArrowLeft');
export const ArrowRight = createIcon(ArrowRight01Icon, 'ArrowRight');
export const ArrowUp = createIcon(ArrowUp01Icon, 'ArrowUp');
export const BadgeAlert = createIcon(BadgeAlertIcon, 'BadgeAlert');
export const BarChart3 = createIcon(BarChartIcon, 'BarChart3');
export const Bell = createIcon(Notification01Icon, 'Bell');
export const BellRing = createIcon(Notification03Icon, 'BellRing');
export const BookOpen = createIcon(BookOpen01Icon, 'BookOpen');
export const BookTemplate = createIcon(Book01Icon, 'BookTemplate');
export const Bot = createIcon(Robot01Icon, 'Bot');
export const Box = createIcon(PackageIcon, 'Box');
export const Brain = createIcon(BrainIcon, 'Brain');
export const Bug = createIcon(Bug01Icon, 'Bug');
export const Building2 = createIcon(Building02Icon, 'Building2');
export const Check = createIcon(Tick02Icon, 'Check');
export const CheckCircle2 = createIcon(CheckmarkCircle02Icon, 'CheckCircle2');
export const ChevronDown = createIcon(ArrowDown01Icon, 'ChevronDown');
export const ChevronLeft = createIcon(ArrowLeft01Icon, 'ChevronLeft');
export const ChevronRight = createIcon(ArrowRight01Icon, 'ChevronRight');
export const ChevronUp = createIcon(ArrowUp01Icon, 'ChevronUp');
export const ChevronsUp = createIcon(ArrowUpDoubleIcon, 'ChevronsUp');
export const ChevronsUpDown = createIcon(ArrowUpDownIcon, 'ChevronsUpDown');
export const Circle = createIcon(CircleIcon, 'Circle');
export const CircleAlert = createIcon(AlertCircleIcon, 'CircleAlert');
export const ClipboardCheck = createIcon(ClipboardCheckIcon, 'ClipboardCheck');
export const ClipboardList = createIcon(ClipboardIcon, 'ClipboardList');
export const Clock = createIcon(Clock01Icon, 'Clock');
export const Code = createIcon(SourceCodeIcon, 'Code');
export const Code2 = createIcon(SourceCodeCircleIcon, 'Code2');
export const Columns2 = createIcon(LayoutTwoColumnIcon, 'Columns2');
export const Command = createIcon(CommandIcon, 'Command');
export const Copy = createIcon(Copy01Icon, 'Copy');
export const DollarSign = createIcon(Dollar01Icon, 'DollarSign');
export const Download = createIcon(Download01Icon, 'Download');
export const Edit2 = createIcon(Edit02Icon, 'Edit2');
export const ExternalLink = createIcon(LinkSquare02Icon, 'ExternalLink');
export const Eye = createIcon(ViewIcon, 'Eye');
export const File = createIcon(File01Icon, 'File');
export const FileCode = createIcon(FileCodeIcon, 'FileCode');
export const FileDiff = createIcon(GitCompareIcon, 'FileDiff');
export const FileImage = createIcon(FileImageIcon, 'FileImage');
export const FileJson = createIcon(FileScriptIcon, 'FileJson');
export const FilePenLine = createIcon(FileEditIcon, 'FilePenLine');
export const FileSpreadsheet = createIcon(FileSpreadsheetIcon, 'FileSpreadsheet');
export const FileText = createIcon(File02Icon, 'FileText');
export const Files = createIcon(Files01Icon, 'Files');
export const Flame = createIcon(FireIcon, 'Flame');
export const FlaskConical = createIcon(TestTube01Icon, 'FlaskConical');
export const FolderClosed = createIcon(Folder01Icon, 'FolderClosed');
export const FolderOpen = createIcon(FolderOpenIcon, 'FolderOpen');
export const FolderSearch = createIcon(FolderSearchIcon, 'FolderSearch');
export const FolderTree = createIcon(FolderTreeIcon, 'FolderTree');
export const Gauge = createIcon(DashboardSpeed01Icon, 'Gauge');
export const Gem = createIcon(DiamondIcon, 'Gem');
export const GitPullRequest = createIcon(GitPullRequestIcon, 'GitPullRequest');
export const Globe = createIcon(Globe02Icon, 'Globe');
export const HeartPulse = createIcon(HeartCheckIcon, 'HeartPulse');
export const History = createIcon(Clock04Icon, 'History');
export const Home = createIcon(Home01Icon, 'Home');
export const Image = createIcon(Image01Icon, 'Image');
export const ImageIcon = createIcon(Image01Icon, 'ImageIcon');
export const Info = createIcon(InformationCircleIcon, 'Info');
export const Key = createIcon(Key01Icon, 'Key');
export const KeyRound = createIcon(Key01Icon, 'KeyRound');
export const Layers3 = createIcon(Layers01Icon, 'Layers3');
export const LayoutGrid = createIcon(GridViewIcon, 'LayoutGrid');
export const LifeBuoy = createIcon(HelpCircleIcon, 'LifeBuoy');
export const Lightbulb = createIcon(Idea01Icon, 'Lightbulb');
export const Link = createIcon(Link01Icon, 'Link');
export const Link2 = createIcon(Link02Icon, 'Link2');
export const List = createIcon(LeftToRightListBulletIcon, 'List');
export const ListChecks = createIcon(CheckListIcon, 'ListChecks');
export const Loader2 = createIcon(Loading03Icon, 'Loader2');
export const LoaderCircle = createIcon(Loading03Icon, 'LoaderCircle');
export const Lock = createIcon(SquareLock01Icon, 'Lock');
export const Maximize2 = createIcon(Maximize01Icon, 'Maximize2');
export const MessageCircle = createIcon(Message01Icon, 'MessageCircle');
export const MessageCircleMore = createIcon(MessageMultiple01Icon, 'MessageCircleMore');
export const MessageSquare = createIcon(Message02Icon, 'MessageSquare');
export const MessageSquareQuote = createIcon(QuoteDownIcon, 'MessageSquareQuote');
export const MessageSquareWarning = createIcon(MessageBlockedIcon, 'MessageSquareWarning');
export const Minimize2 = createIcon(Minimize01Icon, 'Minimize2');
export const Minus = createIcon(MinusSignIcon, 'Minus');
export const Monitor = createIcon(ComputerIcon, 'Monitor');
export const MonitorSmartphone = createIcon(ComputerPhoneSyncIcon, 'MonitorSmartphone');
export const Moon = createIcon(Moon02Icon, 'Moon');
export const MoreHorizontal = createIcon(MoreHorizontalIcon, 'MoreHorizontal');
export const Newspaper = createIcon(NewsIcon, 'Newspaper');
export const Package = createIcon(PackageIcon, 'Package');
export const PackageCheck = createIcon(PackageDeliveredIcon, 'PackageCheck');
export const Palette = createIcon(PaintBoardIcon, 'Palette');
export const PanelLeft = createIcon(SidebarLeft01Icon, 'PanelLeft');
export const PanelRightClose = createIcon(SidebarRight01Icon, 'PanelRightClose');
export const PanelRightOpen = createIcon(SidebarRight01Icon, 'PanelRightOpen');
export const Paperclip = createIcon(AttachmentIcon, 'Paperclip');
export const Pause = createIcon(PauseIcon, 'Pause');
export const PenLine = createIcon(PencilEdit02Icon, 'PenLine');
export const Pencil = createIcon(PencilEdit01Icon, 'Pencil');
export const Pin = createIcon(PinIcon, 'Pin');
export const Play = createIcon(PlayIcon, 'Play');
export const Plug = createIcon(Plug01Icon, 'Plug');
export const Plus = createIcon(PlusSignIcon, 'Plus');
export const PlusSquare = createIcon(PlusSignSquareIcon, 'PlusSquare');
export const QrCode = createIcon(QrCodeIcon, 'QrCode');
export const Radio = createIcon(RadioIcon, 'Radio');
export const RefreshCw = createIcon(RefreshIcon, 'RefreshCw');
export const Rocket = createIcon(Rocket01Icon, 'Rocket');
export const RotateCcw = createIcon(RotateLeft01Icon, 'RotateCcw');
export const RotateCw = createIcon(RotateRight01Icon, 'RotateCw');
export const Save = createIcon(FloppyDiskIcon, 'Save');
export const Scissors = createIcon(ScissorIcon, 'Scissors');
export const ScrollText = createIcon(ScrollIcon, 'ScrollText');
export const Search = createIcon(Search01Icon, 'Search');
export const Send = createIcon(SentIcon, 'Send');
export const ServerCog = createIcon(ServerStack01Icon, 'ServerCog');
export const Settings = createIcon(Settings01Icon, 'Settings');
export const Settings2 = createIcon(Settings02Icon, 'Settings2');
export const Share2 = createIcon(Share01Icon, 'Share2');
export const Shield = createIcon(Shield01Icon, 'Shield');
export const ShieldAlert = createIcon(SecurityWarningIcon, 'ShieldAlert');
export const ShieldBan = createIcon(ShieldBanIcon, 'ShieldBan');
export const ShieldCheck = createIcon(SecurityCheckIcon, 'ShieldCheck');
export const ShieldOff = createIcon(SecurityBlockIcon, 'ShieldOff');
export const Sparkles = createIcon(SparklesIcon, 'Sparkles');
export const Square = createIcon(SquareIcon, 'Square');
export const SquareArrowOutUpRight = createIcon(LinkSquare01Icon, 'SquareArrowOutUpRight');
export const SquarePen = createIcon(Edit02Icon, 'SquarePen');
export const SquareTerminal = createIcon(TerminalIcon, 'SquareTerminal');
export const Star = createIcon(StarIcon, 'Star');
export const Sun = createIcon(Sun01Icon, 'Sun');
export const Target = createIcon(Target01Icon, 'Target');
export const Terminal = createIcon(TerminalIcon, 'Terminal');
export const TerminalSquare = createIcon(TerminalIcon, 'TerminalSquare');
export const Timer = createIcon(Timer01Icon, 'Timer');
export const Trash2 = createIcon(Delete02Icon, 'Trash2');
export const TrendingDown = createIcon(TradeDownIcon, 'TrendingDown');
export const TrendingUp = createIcon(TradeUpIcon, 'TrendingUp');
export const Users = createIcon(UserGroupIcon, 'Users');
export const Workflow = createIcon(WorkflowSquare01Icon, 'Workflow');
export const Wrench = createIcon(Wrench01Icon, 'Wrench');
export const X = createIcon(Cancel01Icon, 'X');
export const XCircle = createIcon(CancelCircleIcon, 'XCircle');
export const Zap = createIcon(ZapIcon, 'Zap');
