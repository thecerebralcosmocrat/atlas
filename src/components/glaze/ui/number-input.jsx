'use client';;
import {NumberField as NumberFieldPrimitive} from '@base-ui/react/number-field';
import {Icon, Add, Subtract} from '@/components/glaze/icon';
import {cn} from '@/lib/glaze/utils';
import {useFieldDisabled} from '@/components/glaze/ui/field';
import { InputAction, InputLeading, InputRoot, InputTrailing } from '@/components/glaze/ui/input';

/** A stepper is a control, so its glyph is text-2 at rest; at its bound, or in a disabled field, it drops to
    text-disabled and loses its wash. At text-3 the drop to text-disabled was too small to read as off. */
const stepperClass = '[&_svg]:text-text-2 disabled:bg-transparent disabled:text-text-disabled data-disabled:bg-transparent data-disabled:text-text-disabled aria-disabled:text-text-disabled aria-disabled:hover:bg-transparent disabled:[&_svg]:text-text-disabled! aria-disabled:[&_svg]:text-text-disabled!';

const textSize = {sm: 'type-caption', default: 'type-body-sm', lg: 'type-body'};

function NumberInput({
  size = 'default',
  unit,
  leading,
  placeholder,
  className,
  disabled: disabledProp,
  onValueChange,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ref,
  ...props
}) {
  const disabled = useFieldDisabled() || !!disabledProp;
  const forced = Object.fromEntries(Object.entries(props).filter(([k]) => k.startsWith('data-force-')));
  const rest = Object.fromEntries(Object.entries(props).filter(([k]) => !k.startsWith('data-force-')));
  return <NumberFieldPrimitive.Root
    data-slot="number-input"
    disabled={disabled}
    onValueChange={v => onValueChange?.(v)}
    {...rest}
  >
    <NumberFieldPrimitive.Group
      data-slot="number-input-group"
      render={<InputRoot size={size} disabled={disabled} readOnly={props.readOnly}/>}
      data-invalid={invalid || undefined}
      // A stepper at its bound is a disabled button inside the pill, which the field recipe would read as a disabled field.
      className={cn('gap-1 px-3 not-data-disabled:bg-paper! not-data-disabled:text-text-1!', className)}
      {...forced}
    >
      {leading !== undefined && <InputLeading>{leading}</InputLeading>}
      <InputLeading>
        <NumberFieldPrimitive.Decrement data-slot="number-input-decrement" aria-label="Decrease" tabIndex={-1} render={<InputAction className={stepperClass}/>}><Icon icon={Subtract}/></NumberFieldPrimitive.Decrement>
      </InputLeading>
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1">
        <NumberFieldPrimitive.Input
          ref={ref}
          data-slot="number-input-control"
          data-control=""
          placeholder={placeholder}
          aria-label={ariaLabel}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={cn('h-full w-full min-w-0 bg-transparent text-text-1 data disabled:text-text-disabled placeholder:text-text-3 disabled:cursor-not-allowed', textSize[size], unit ? 'w-auto min-w-4 text-end field-sizing-content' : 'text-center')}
        />
        {unit && <span data-slot="number-input-unit" aria-hidden className={cn('shrink-0 text-text-3 group-data-disabled/input:text-text-disabled', textSize[size])}>{unit}</span>}
      </span>
      <InputTrailing>
        <NumberFieldPrimitive.Increment data-slot="number-input-increment" aria-label="Increase" tabIndex={-1} render={<InputAction className={stepperClass}/>}><Icon icon={Add}/></NumberFieldPrimitive.Increment>
      </InputTrailing>
    </NumberFieldPrimitive.Group>
  </NumberFieldPrimitive.Root>;
}

export { NumberInput };
