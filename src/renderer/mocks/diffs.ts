import type { FileDiff } from '@shared/agent'

export const checkoutDiff: FileDiff[] = [
  {
    path: 'src/checkout/__tests__/checkout.spec.ts',
    status: 'modified',
    added: 6,
    removed: 3,
    hunks: [
      {
        header: '@@ -31,9 +31,12 @@ describe("checkout totals", () => {',
        lines: [
          { type: 'ctx', text: '  it("applies the discount after tax rules", async () => {', oldNo: 31, newNo: 31 },
          { type: 'ctx', text: '    const cart = buildCart({ items: 3, coupon: "SPRING" })', oldNo: 32, newNo: 32 },
          { type: 'del', text: '    const total = checkout(cart)', oldNo: 33 },
          { type: 'del', text: '    await sleep(50)', oldNo: 34 },
          { type: 'del', text: '    expect(total.cents).toBe(4_250)', oldNo: 35 },
          { type: 'add', text: '    // The pricing service resolves asynchronously: wait for it instead of sleeping.', newNo: 33 },
          { type: 'add', text: '    const total = await checkout(cart)', newNo: 34 },
          { type: 'add', text: '    await waitFor(() => expect(pricing.pending()).toBe(0))', newNo: 35 },
          { type: 'add', text: '    expect(total.cents).toBe(4_250)', newNo: 36 },
          { type: 'ctx', text: '  })', oldNo: 36, newNo: 37 },
          { type: 'ctx', text: '', oldNo: 37, newNo: 38 }
        ]
      }
    ]
  },
  {
    path: 'src/checkout/pricing.ts',
    status: 'modified',
    added: 5,
    removed: 1,
    hunks: [
      {
        header: '@@ -12,7 +12,11 @@ export class PricingClient {',
        lines: [
          { type: 'ctx', text: '  private inflight = 0', oldNo: 12, newNo: 12 },
          { type: 'ctx', text: '', oldNo: 13, newNo: 13 },
          { type: 'del', text: '  async quote(cart: Cart) {', oldNo: 14 },
          { type: 'add', text: '  /** Number of quotes still being resolved. Tests wait for this to reach zero. */', newNo: 14 },
          { type: 'add', text: '  pending(): number {', newNo: 15 },
          { type: 'add', text: '    return this.inflight', newNo: 16 },
          { type: 'add', text: '  }', newNo: 17 },
          { type: 'add', text: '', newNo: 18 },
          { type: 'add', text: '  async quote(cart: Cart) {', newNo: 19 },
          { type: 'ctx', text: '    this.inflight++', oldNo: 15, newNo: 20 }
        ]
      }
    ]
  }
]

export const validationDiff: FileDiff[] = [
  {
    path: 'src/auth/LoginForm.tsx',
    status: 'modified',
    added: 11,
    removed: 2,
    hunks: [
      {
        header: '@@ -18,10 +18,19 @@ export function LoginForm({ onSubmit }: Props) {',
        lines: [
          { type: 'ctx', text: '  const [email, setEmail] = useState("")', oldNo: 18, newNo: 18 },
          { type: 'ctx', text: '  const [password, setPassword] = useState("")', oldNo: 19, newNo: 19 },
          { type: 'add', text: '  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})', newNo: 20 },
          { type: 'ctx', text: '', oldNo: 20, newNo: 21 },
          { type: 'del', text: '  const submit = () => onSubmit({ email, password })', oldNo: 21 },
          { type: 'add', text: '  const submit = () => {', newNo: 22 },
          { type: 'add', text: '    const next = validateLogin({ email, password })', newNo: 23 },
          { type: 'add', text: '    setErrors(next)', newNo: 24 },
          { type: 'add', text: '    if (Object.keys(next).length === 0) onSubmit({ email, password })', newNo: 25 },
          { type: 'add', text: '  }', newNo: 26 },
          { type: 'ctx', text: '', oldNo: 22, newNo: 27 },
          { type: 'ctx', text: '  return (', oldNo: 23, newNo: 28 }
        ]
      }
    ]
  },
  {
    path: 'src/auth/validateLogin.ts',
    status: 'added',
    added: 14,
    removed: 0,
    hunks: [
      {
        header: '@@ -0,0 +1,14 @@',
        lines: [
          { type: 'add', text: 'export interface LoginFields {', newNo: 1 },
          { type: 'add', text: '  email: string', newNo: 2 },
          { type: 'add', text: '  password: string', newNo: 3 },
          { type: 'add', text: '}', newNo: 4 },
          { type: 'add', text: '', newNo: 5 },
          { type: 'add', text: 'export function validateLogin({ email, password }: LoginFields) {', newNo: 6 },
          { type: 'add', text: '  const errors: { email?: string; password?: string } = {}', newNo: 7 },
          { type: 'add', text: '  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(email)) errors.email = "Enter a valid email address."', newNo: 8 },
          { type: 'add', text: '  if (password.length < 8) errors.password = "Use at least 8 characters."', newNo: 9 },
          { type: 'add', text: '  return errors', newNo: 10 },
          { type: 'add', text: '}', newNo: 11 }
        ]
      }
    ]
  }
]
