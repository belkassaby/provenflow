plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

kotlin {
    // IntelliJ Platform 2026.2 runs on Java 25.
    jvmToolchain(25)
}

dependencies {
    testImplementation("junit:junit:4.13.2")

    intellijPlatform {
        val localPath = providers.gradleProperty("platformLocalPath")
        if (localPath.isPresent) local(localPath.get()) else intellijIdea(providers.gradleProperty("platformVersion"))
        // The editor tabs: JCEF is a bundled plugin of its own since 2026.2.
        bundledPlugin("com.intellij.modules.jcef")
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "262"
        }
    }
    // Plugins are searchable without an index of their settings page.
    buildSearchableOptions = false
}
