# Firebase Functions Pricing - Checking Every Minute

## Free Tier Limits

Firebase Functions free tier includes:
- ✅ **2 million invocations per month** (free)
- ✅ **400,000 GB-seconds compute time** (free)
- ✅ **5 GB outbound networking** (free)

## Cost Analysis: Checking Every 30 Seconds

### Invocations
- **Every 30 seconds**: 120 checks/hour × 24 hours × 30 days = **86,400 invocations/month**
- **Free tier**: 2,000,000 invocations/month
- **Result**: ✅ **Well within free tier** (only 4.32% of limit)

### Compute Time
- Each check typically runs in **1-3 seconds**
- Assuming 2 seconds average × 86,400 = **172,800 seconds**
- With 256MB memory (default): 172,800 × 0.256 GB = **44,237 GB-seconds**
- **Free tier**: 400,000 GB-seconds
- **Result**: ✅ **Well within free tier** (only 11% of limit)

### Networking
- Gmail API calls are minimal data transfer
- **Result**: ✅ **Negligible** (well under 5 GB)

## Conclusion

**Checking every minute is completely FREE** ✅

You're using:
- 2.16% of invocation limit
- 5.5% of compute time limit
- <1% of networking limit

## Even More Frequent?

You could check **every 15 seconds** and still be free:
- 172,800 invocations/month (8.6% of limit)
- Still well within all free tier limits

## Monitoring Usage

Check your usage in Firebase Console:
1. Go to Firebase Console
2. Functions > Usage
3. Monitor invocations, compute time, and networking

## If You Exceed Free Tier

If you somehow exceed (unlikely):
- **Invocations**: $0.40 per million after free tier
- **Compute**: $0.0000025 per GB-second after free tier
- **Networking**: $0.12 per GB after free tier

Even if you exceeded, costs would be minimal (cents per month).

## Recommendation

**Every 30 seconds is perfect** - very fast response time, completely free! 🎉

The function runs at :00 and :30 of every minute, effectively checking every 30 seconds.

