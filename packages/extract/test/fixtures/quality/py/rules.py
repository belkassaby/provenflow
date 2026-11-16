"""Seeded for the quality checks: a complex function, and an import of a package that is not declared."""
import requestz


def classify(order, member, coupon=None):
    kind = "standard"
    for line in order:
        if line["quantity"] > 0:
            if member:
                for i in range(line["quantity"]):
                    if line["category"] == "food" and i > 2:
                        if coupon and coupon.startswith("FOOD"):
                            kind = "food-coupon"
                        else:
                            kind = "food"
            elif coupon:
                kind = "coupon" if line["category"] == "books" else "other"
    return kind


def fetch(url):
    return requestz.get(url)
