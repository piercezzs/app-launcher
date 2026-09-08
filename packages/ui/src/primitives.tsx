import type {
  ButtonHTMLAttributes,
  ComponentPropsWithoutRef,
  InputHTMLAttributes,
  PropsWithChildren,
  ReactNode,
  SelectHTMLAttributes,
} from "react";
import * as DialogPrimitiveRadix from "@radix-ui/react-dialog";

type Tone = "neutral" | "primary" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: Tone;
  readonly icon?: ReactNode;
  readonly loading?: boolean;
}

export function Button({
  tone = "neutral",
  icon,
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: ButtonProps) {
  const classes = ["ui-btn", `ui-btn--${tone}`, className].filter(Boolean).join(" ");
  return (
    <button
      {...props}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading ? true : props["aria-busy"]}
    >
      {loading ? (
        <span className="ui-spinner" aria-hidden />
      ) : icon ? (
        <span className="ui-btn__icon" aria-hidden>{icon}</span>
      ) : null}
      <span className="ui-btn__label">{children}</span>
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
  readonly tone?: Tone;
  readonly loading?: boolean;
}

export function IconButton({
  label,
  tone = "neutral",
  loading = false,
  children,
  className = "",
  disabled,
  ...props
}: IconButtonProps) {
  const classes = ["ui-icon-btn", `ui-icon-btn--${tone}`, className].filter(Boolean).join(" ");
  return (
    <button className={classes} aria-label={label} title={label} disabled={disabled || loading} {...props}>
      {loading ? <span className="ui-spinner" aria-hidden /> : children}
    </button>
  );
}

/**
 * 可组合的 Radix Dialog 原语，供需要定制布局的 app 使用（如 Tessera 表单）。
 * 统一从 @tessera/ui 导入，app 内不再直接依赖 @radix-ui/react-dialog。
 */
export const DialogPrimitive = DialogPrimitiveRadix;

export interface DialogProps extends PropsWithChildren {
  readonly title: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly onEscapeKeyDown?: ComponentPropsWithoutRef<typeof DialogPrimitiveRadix.Content>["onEscapeKeyDown"];
}

/**
 * 预设 Dialog：标题 + 滚动 body + 可选 footer。
 * 基于 Radix，自带焦点陷阱、背景滚动锁、Esc/点击遮罩关闭。
 */
export function Dialog({ title, open, onClose, footer, onEscapeKeyDown, children }: DialogProps) {
  return (
    <DialogPrimitiveRadix.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitiveRadix.Portal>
        <DialogPrimitiveRadix.Overlay className="ui-dialog-backdrop" />
        <DialogPrimitiveRadix.Content className="ui-dialog" aria-describedby={undefined} onEscapeKeyDown={onEscapeKeyDown}>
          <header className="ui-dialog__head">
            <DialogPrimitiveRadix.Title asChild>
              <h2>{title}</h2>
            </DialogPrimitiveRadix.Title>
            <DialogPrimitiveRadix.Close asChild>
              <IconButton label="关闭" title={undefined}>
                <span aria-hidden>×</span>
              </IconButton>
            </DialogPrimitiveRadix.Close>
          </header>
          <div className="ui-dialog__body">{children}</div>
          {footer ? <footer className="ui-dialog__foot">{footer}</footer> : null}
        </DialogPrimitiveRadix.Content>
      </DialogPrimitiveRadix.Portal>
    </DialogPrimitiveRadix.Root>
  );
}

export interface FieldProps extends PropsWithChildren {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly className?: string;
}

/** 表单字段包装：label + 控件 + 可选提示。 */
export function Field({ label, hint, className = "", children }: FieldProps) {
  const classes = ["ui-field", className].filter(Boolean).join(" ");
  return (
    <label className={classes}>
      <span className="ui-field__label">{label}</span>
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </label>
  );
}

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput({ className = "", ...props }: TextInputProps) {
  return <input className={["ui-input", className].filter(Boolean).join(" ")} {...props} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className = "", children, ...props }: SelectProps) {
  return (
    <select className={["ui-input", "ui-select", className].filter(Boolean).join(" ")} {...props}>
      {children}
    </select>
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly label: ReactNode;
}

export function Checkbox({ label, className = "", ...props }: CheckboxProps) {
  return (
    <label className={["ui-checkbox", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
