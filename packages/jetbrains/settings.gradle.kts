import org.jetbrains.intellij.platform.gradle.extensions.intellijPlatform

rootProject.name = "provenflow-jetbrains"

pluginManagement {
    plugins {
        id("org.jetbrains.kotlin.jvm") version "2.4.21"
    }
}

plugins {
    // Downloads a Java 25 when none is installed (an IDE's bundled runtime counts: see docs/jetbrains.md).
    id("org.gradle.toolchains.foojay-resolver-convention") version "1.0.0"
    id("org.jetbrains.intellij.platform.settings") version "2.20.1"
}

@Suppress("UnstableApiUsage")
dependencyResolutionManagement {
    repositories {
        mavenCentral()
        intellijPlatform {
            defaultRepositories()
        }
    }
}
