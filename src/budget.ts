/**
 * Cloudflare's free plan allows 50 subrequests (fetch + KV calls) per invocation.
 * Every outgoing call goes through take() so we never blow past it.
 */
export class BudgetExceeded extends Error {
  constructor() {
    super('subrequest budget exhausted');
  }
}

export class Budget {
  private used = 0;
  constructor(private readonly limit = 45) {}

  take(n = 1): boolean {
    if (this.used + n > this.limit) return false;
    this.used += n;
    return true;
  }
  get left(): number {
    return this.limit - this.used;
  }
  get spent(): number {
    return this.used;
  }
}
