/* eslint-disable react/no-danger */
import { Children } from 'react'
import { LOADABLE } from '../constants'
import DeferredState from './DeferredState'

// Recurse a React Element tree, running visitor on each element.
// If visitor returns `false`, don't call the element's render function
// or recurse into its child elements
export function walkTree(element, context, visitor) {
  const Component = element.type
  // a stateless functional component or a class
  if (typeof Component === 'function') {
    const props = { ...Component.defaultProps, ...element.props }
    let childContext = context
    let child

    // Are we are a react class?
    //   https://github.com/facebook/react/blob/master/src/renderers/shared/stack/reconciler/ReactCompositeComponent.js#L66
    if (Component.prototype && Component.prototype.isReactComponent) {
      // typescript force casting since typescript doesn't have definitions for class
      // methods
      const instance = new Component(props, context)
      // In case the user doesn't pass these to super in the constructor
      instance.props = instance.props || props
      instance.context = instance.context || context

      // Override setState to just change the state, not queue up an update.
      //   (we can't do the default React thing as we aren't mounted "properly"
      //   however, we don't need to re-render as well only support setState in
      //   componentWillMount, which happens *before* render).
      instance.setState = nextState => {
        instance.state = { ...instance.state, ...nextState }
      }

      // this is a poor man's version of
      //   https://github.com/facebook/react/blob/master/src/renderers/shared/stack/reconciler/ReactCompositeComponent.js#L181
      if (instance.componentWillMount) {
        instance.componentWillMount()
      }

      if (instance.getChildContext) {
        childContext = { ...context, ...instance.getChildContext() }
      }

      if (visitor(element, instance, context) === false) {
        return
      }

      child = instance.render()
    } else {
      // just a stateless functional
      if (visitor(element, null, context) === false) {
        return
      }

      // typescript casting for stateless component
      child = Component(props, context)
    }

    if (child) {
      walkTree(child, childContext, visitor)
    }
  } else {
    // a basic string or dom element, just get children
    if (visitor(element, null, context) === false) {
      return
    }

    if (element.props && element.props.children) {
      Children.forEach(element.props.children, (child: any) => {
        if (child) {
          walkTree(child, context, visitor)
        }
      })
    }
  }
}

function getQueriesFromTree(
  { rootElement, rootContext = {} },
  fetchRoot = true,
) {
  const queries = []

  walkTree(rootElement, rootContext, (element, instance, context) => {
    const skipRoot = !fetchRoot && element === rootElement

    if (instance && instance.constructor[LOADABLE] && !skipRoot) {
      const loadable = instance.constructor[LOADABLE]()
      const query = loadable.load().then(() => {
        if (!loadable.componentId) {
          throw new Error(
            'loadable-components: modules entry is missing, your are probably missing `loadable-components/babel`',
          )
        }
        return loadable.componentId
      })

      if (query) {
        queries.push({ query, element, context })

        // Tell walkTree to not recurse inside this component;  we will
        // wait for the query to execute before attempting it.
        return false
      }
    }

    return true
  })

  return queries
}

export function getLoadableState(
  rootElement,
  rootContext = {},
  fetchRoot = true,
  tree = {},
) {
  const queries = getQueriesFromTree({ rootElement, rootContext }, fetchRoot)

  // no queries found, nothing to do
  if (!queries.length) return Promise.resolve(new DeferredState(tree))

  const errors = []
  tree.children = []

  // wait on each query that we found, re-rendering the subtree when it's done
  const mappedQueries = queries.map(({ query, element, context }) =>
    // we've just grabbed the query for element, so don't try and get it again
    query
      .then(id => {
        const subTree = { id }
        tree.children.push(subTree)
        return getLoadableState(element, context, false, subTree)
      })
      .catch(e => errors.push(e)),
  )

  return Promise.all(mappedQueries).then(() => {
    if (errors.length > 0) {
      if (errors.length === 1) {
        throw errors[0];
      } else {
        const err = new Error(
          `${errors.length} errors were thrown when importing your modules.`
        );
        err.queryErrors = errors
        throw err;
      }
    }

    return new DeferredState(tree)
  })
}
