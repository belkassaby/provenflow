#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int first(int *values) {
    return values[0];
}

int ratio(int total, int parts) {
    return total / parts;
}

int add(int a, int b) {
    return a + b;
}

int clamp(int x) {
    if (x < 0) return 0;
    if (x > 100) return 100;
    return x;
}

void greet(const char *name) {
    char buffer[16];
    strcpy(buffer, name);
    printf("%s\n", buffer);
}

char *copy(const char *s) {
    char *d = malloc(strlen(s) + 1);
    if (!d) return NULL;
    strcpy(d, s);
    return d;
}

int length(const char *s) {
    char *d = copy(s);
    return (int)strlen(d);
}
